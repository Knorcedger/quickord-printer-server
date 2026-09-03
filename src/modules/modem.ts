import { SerialPort } from 'serialport';
import signale from 'signale';

import { apiCall } from './api';
import { shouldEmit } from './modemDedup';
import { feed } from './modemParser';
import { getModems, getSettings, IModemSettings } from './settings';

const KEEPALIVE_INTERVAL_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;

// Sent one by one after open, each waiting for its own OK/ERROR.
// AT -> wakes the modem after a cold boot, before anything else is sent
// AT+VCID=1 -> this enables caller id on the modem
// AT+GCI=B5 -> this changes the setup country (B5 is for USA but caller id is not working with Greece(46))
// ATS24=0 -> disables the Conexant sleep-inactivity timer; a sleeping chip
// misses the CID burst on the first call after long idle (ignored by others)
const INIT_COMMANDS = ['AT', 'AT+GCI=B5', 'ATS24=0', 'AT+VCID=1'];

// Init handshake timings; tests shrink them through __setInitTimings.
const timings = {
  attempts: 2, // total attempts per command, not retries
  backoffMs: 500,
  drainMs: 1500, // boot-time output to discard before the first command
  settleMs: 200, // window we watch for the ATE1 echo
  timeoutMs: 3000,
};

// A RING with no CID block behind it means the modem lost AT+VCID=1 (it does
// that after a USB power-cycle, e.g. when Windows sleeps).
const RING_WITHOUT_CID_MS = 4000;
const RECENT_NMBR_WINDOW_MS = 30_000;
const MAX_CONSECUTIVE_VCID_REISSUES = 3;
// "3 in a row" must mean right now: an old streak decays instead of eventually
// force-reconnecting a modem whose line simply has no caller id.
const VCID_REISSUE_DECAY_MS = 10 * 60_000;

// Every modem runs as an instance: all state that used to be module-level lives
// here, so a second modem no longer shares the buffer, timers or callback of the
// first one.
type ModemInstance = {
  buffer: string;
  closing: boolean;
  consecutiveVcidReissues: number;
  // Set while init runs, so the AT replies can be read off the data handler.
  initListener: ((chunk: string) => void) | null;
  initPromise: Promise<void> | null;
  isReconnecting: boolean;
  keepalive: ReturnType<typeof setInterval> | null;
  readonly key: string;
  lastNmbrAt: number;
  lastVcidReissueAt: number;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  ringTimer: ReturnType<typeof setTimeout> | null;
  serial: InstanceType<typeof SerialPort> | null;
  settings: IModemSettings;
};

const registry = new Map<string, ModemInstance>();

// Swapped for SerialPortMock in tests.
type PortCtor = typeof SerialPort;
let PortImpl: PortCtor = SerialPort;
export const __setSerialPortImpl = (impl: PortCtor) => {
  PortImpl = impl;
};

// The modem needs a moment after open before it accepts anything.
let initDelayMs = 500;
export const __setInitDelayMs = (ms: number) => {
  initDelayMs = ms;
};

export const __setInitTimings = (t: Partial<typeof timings>) => {
  Object.assign(timings, t);
};

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const tag = (inst: ModemInstance) =>
  `[modem ${inst.settings.label ? `${inst.settings.label}/` : ''}${inst.key}]`;

const clearRingTimer = (inst: ModemInstance) => {
  if (inst.ringTimer) {
    clearTimeout(inst.ringTimer);
    inst.ringTimer = null;
  }
};

// Call-state bookkeeping is per connection: a fresh port must not inherit the
// re-issue streak or the NMBR timestamp of the one it replaces.
const resetCallState = (inst: ModemInstance) => {
  clearRingTimer(inst);
  inst.consecutiveVcidReissues = 0;
  inst.lastNmbrAt = 0;
  inst.lastVcidReissueAt = 0;
};

const clearTimers = (inst: ModemInstance) => {
  if (inst.keepalive) {
    clearInterval(inst.keepalive);
    inst.keepalive = null;
  }
  if (inst.reconnectTimer) {
    clearTimeout(inst.reconnectTimer);
    inst.reconnectTimer = null;
  }
  clearRingTimer(inst);
  inst.isReconnecting = false;
};

const detachPort = (inst: ModemInstance) => {
  inst.initListener = null;
  if (!inst.serial) return;
  // Remove listeners BEFORE close so it doesn't trigger a reconnect. Keep a
  // sink for 'error': closing cancels a pending write and an unhandled 'error'
  // event would take the process down.
  inst.serial.removeAllListeners();
  inst.serial.on('error', () => {});
  if (inst.serial.isOpen) inst.serial.close();
  inst.serial = null;
};

const onPhoneNumber = async (inst: ModemInstance, phoneNumber: string) => {
  signale.info(`${tag(inst)} Phone call detected: ${phoneNumber}`);

  const venueId = getSettings().venueId || inst.settings.venueId;

  if (!venueId) {
    signale.error(`${tag(inst)} No venueId configured, dropping call`);
    return;
  }

  // Only consume a dedup slot for a call we will actually emit.
  if (!shouldEmit(phoneNumber)) {
    signale.info(
      `${tag(inst)} Duplicate call ${phoneNumber} within dedup window, skipping`
    );
    return;
  }

  try {
    signale.info(
      `${tag(inst)} Sending phone info to BE: phoneNumber: "${phoneNumber}", venueId:"${venueId}"`
    );

    const response = await apiCall(
      `mutation { incomingPhoneCall(phoneNumber: "${phoneNumber}", venueId:"${venueId}") { status } }`
    );

    if (response?.errors) {
      signale.error(
        `${tag(inst)} failed to call BE for phonecall`,
        JSON.stringify(response.errors, null, 2)
      );
    } else {
      signale.info(`${tag(inst)} Phone info sent`);
    }
  } catch (err) {
    signale.error(`${tag(inst)} error sending phone data to BE`);
    signale.error(err);
  }
};

const startKeepalive = (inst: ModemInstance) => {
  if (inst.keepalive) clearInterval(inst.keepalive);

  inst.keepalive = setInterval(() => {
    if (!inst.serial || !inst.serial.isOpen) return;
    inst.serial.write('AT\r', (err) => {
      if (err) {
        signale.error(`${tag(inst)} keepalive failed:`, err.message);
        scheduleReconnect(inst);
      }
    });
  }, KEEPALIVE_INTERVAL_MS);
};

// The modem answers a RING without a CID block when it lost AT+VCID=1; re-issue
// it, and if that keeps happening the port itself is stuck, so reconnect.
const reissueVcid = (inst: ModemInstance, reason: string) => {
  if (!inst.serial?.isOpen || inst.closing) return;

  const now = Date.now();
  if (now - inst.lastVcidReissueAt > VCID_REISSUE_DECAY_MS) {
    inst.consecutiveVcidReissues = 0;
  }
  inst.lastVcidReissueAt = now;
  inst.consecutiveVcidReissues++;

  if (inst.consecutiveVcidReissues >= MAX_CONSECUTIVE_VCID_REISSUES) {
    inst.consecutiveVcidReissues = 0;
    if (inst.isReconnecting) return;
    signale.error(
      `${tag(inst)} VCID re-issue hit ${MAX_CONSECUTIVE_VCID_REISSUES}x in a row — modem appears stuck, forcing reconnect`
    );
    // Start the backoff from scratch: this is a fresh failure mode and must not
    // inherit an exhausted attempt counter that would give up immediately.
    inst.reconnectAttempt = 0;
    detachPort(inst);
    scheduleReconnect(inst);
    return;
  }

  signale.info(`${tag(inst)} re-issuing AT+VCID=1 (${reason})`);
  inst.serial.write('AT+VCID=1\r', (err) => {
    if (err)
      signale.error(`${tag(inst)} VCID re-issue write failed:`, err.message);
  });
};

// The CID block is sent once, between the first and second RING, so later RINGs
// of the same call legitimately carry no NMBR.
const watchRingWithoutCid = (inst: ModemInstance, chunk: string) => {
  if (!/\bRING\b/.test(chunk) || inst.ringTimer) return;
  if (Date.now() - inst.lastNmbrAt < RECENT_NMBR_WINDOW_MS) return;

  inst.ringTimer = setTimeout(() => {
    inst.ringTimer = null;
    if (inst.buffer.includes('NMBR')) return;
    if (Date.now() - inst.lastNmbrAt < RECENT_NMBR_WINDOW_MS) return;

    signale.warn(
      `${tag(inst)} RING received without NMBR (CID block) — VCID may not be enabled`
    );
    reissueVcid(inst, 'RING without NMBR');
  }, RING_WITHOUT_CID_MS);
};

// An OK/ERROR counts only if it follows the echoed command, so leftover
// boot-time output can't pass for a reply. Anchoring the echo to a line start
// and terminator keeps e.g. the "AT" of an "AT+GCI=B5" echo from matching a
// plain "AT". Without echo there is nothing to anchor to.
export const matchInitReply = (
  buffer: string,
  cmd: string,
  echoOn: boolean
): 'error' | 'ok' | null => {
  let after = buffer;

  if (echoOn) {
    const echo = new RegExp(
      `(?:^|[\\r\\n])${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\r|\\n)`
    ).exec(buffer);
    if (!echo) return null;
    after = buffer.slice(echo.index + echo[0].length);
  }

  if (/\bERROR\b/.test(after)) return 'error';
  if (/\bOK\b/.test(after)) return 'ok';
  return null;
};

// Wait for the modem to answer OK/ERROR to one init command.
const sendInitCommand = (
  inst: ModemInstance,
  serial: InstanceType<typeof SerialPort>,
  cmd: string,
  echoOn: boolean
): Promise<void> => {
  const tryOnce = () =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      let buf = '';
      let listener: ((chunk: string) => void) | null = null;
      let timer: ReturnType<typeof setTimeout>;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Only drop the listener if it is still ours: a superseding init may
        // have installed its own in the meantime.
        if (inst.initListener === listener) inst.initListener = null;
        if (err) reject(err);
        else resolve();
      };

      listener = (chunk: string) => {
        if (settled) return;
        buf += chunk;

        const reply = matchInitReply(buf, cmd, echoOn);
        if (reply === 'error')
          finish(new Error(`modem replied ERROR to ${cmd}`));
        else if (reply === 'ok') finish();
      };

      timer = setTimeout(
        () =>
          finish(
            new Error(
              `timeout waiting for reply to ${cmd} (got: ${JSON.stringify(buf)})`
            )
          ),
        timings.timeoutMs
      );

      inst.initListener = listener;
      signale.info(`${tag(inst)} init -> ${cmd}`);
      serial.write(Buffer.from(`${cmd}\r`), (err) => {
        if (err) finish(err);
      });
    });

  const attemptLoop = async (attempt = 1): Promise<void> => {
    try {
      await tryOnce();
      signale.info(`${tag(inst)} init '${cmd}' OK`);
    } catch (err) {
      signale.warn(
        `${tag(inst)} init '${cmd}' attempt ${attempt}/${timings.attempts} failed: ${(err as Error).message}`
      );
      if (attempt >= timings.attempts) {
        throw new Error(
          `init command '${cmd}' failed after ${timings.attempts} attempts`
        );
      }
      await wait(timings.backoffMs * attempt);
      if (inst.closing || inst.serial !== serial) {
        throw new Error('modem instance superseded during init');
      }
      return attemptLoop(attempt + 1);
    }
    return undefined;
  };

  return attemptLoop();
};

// Drain the boot-time output, force echo on, then hand the init commands to the
// modem one by one. Detached from openPort on purpose: a silent modem burns the
// whole retry budget and must not hold up startup or a settings POST.
const runInit = async (
  inst: ModemInstance,
  serial: InstanceType<typeof SerialPort>
) => {
  const alive = () => !inst.closing && inst.serial === serial && serial.isOpen;

  const collect = async (ms: number) => {
    let out = '';
    const listener = (chunk: string) => {
      out += chunk;
    };
    inst.initListener = listener;
    await wait(ms);
    if (inst.initListener === listener) inst.initListener = null;
    return out;
  };

  const drained = await collect(timings.drainMs);
  if (drained.length) {
    signale.info(
      `${tag(inst)} drained pre-init output: ${JSON.stringify(drained.slice(0, 256))}`
    );
  }
  if (!alive()) return;

  // ATE1 is fire-and-forget: a modem booted with ATE0 does not echo it back, so
  // waiting for the echo would always time out.
  signale.info(`${tag(inst)} init -> ATE1 (fire-and-forget)`);
  serial.write('ATE1\r');
  const echoOn = /ATE1/.test(await collect(timings.settleMs));
  if (!echoOn) {
    signale.warn(
      `${tag(inst)} no ATE1 echo, matching init replies without the echo anchor`
    );
  }
  if (!alive()) return;

  // Failures are logged but non-fatal: some modems don't support AT+GCI or
  // ATS24, and on others VCID is already persisted in NVRAM. Keeping the port
  // open lets call detection work; the RING watchdog re-issues VCID if needed.
  for (const cmd of INIT_COMMANDS) {
    if (!alive()) return;
    // eslint-disable-next-line no-await-in-loop
    await sendInitCommand(inst, serial, cmd, echoOn).catch((err: Error) =>
      signale.warn(
        `${tag(inst)} init '${cmd}' did not complete: ${err.message} — continuing anyway`
      )
    );
  }
  // The AT/OK echoes need no cleanup here: feed() drops them as noise lines,
  // and clearing the buffer could eat a CID block that is arriving right now.
};

const openPort = async (inst: ModemInstance) => {
  inst.buffer = '';
  resetCallState(inst);

  const serial = new PortImpl({
    autoOpen: false,
    baudRate: 9600,
    // path: '/dev/ttyACM0', ---> linux driver writes to this file
    path: inst.settings.port,
  });

  serial.setEncoding('utf-8');

  await new Promise<void>((resolve, reject) => {
    serial.open((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  if (initDelayMs > 0) {
    await new Promise((resolve) => {
      setTimeout(() => resolve(''), initDelayMs);
    });
  }

  // A concurrent sync may have closed/replaced this instance while open() or
  // the init delay was pending; attaching now would leak an untracked open
  // port with a keepalive nothing can ever clear.
  if (inst.closing || registry.get(inst.key) !== inst) {
    serial.removeAllListeners();
    serial.on('error', () => {});
    if (serial.isOpen) serial.close();
    throw new Error('modem instance superseded while opening');
  }

  // The init commands (see INIT_COMMANDS) are written by runInit below, after
  // the data handler is attached: it is what feeds them their replies.
  serial.on('data', (d: Buffer) => {
    const chunk = d.toString();
    signale.debug(`${tag(inst)} raw ${JSON.stringify(chunk)}`);

    inst.initListener?.(chunk);
    watchRingWithoutCid(inst, chunk);

    const result = feed(inst.buffer, chunk);
    inst.buffer = result.buffer;

    if (result.overflowed) {
      signale.warn(
        `${tag(inst)} Buffer overflow, clearing. Content: ${JSON.stringify(result.overflowed)}`
      );
    }

    if (result.phoneNumber) {
      inst.lastNmbrAt = Date.now();
      inst.consecutiveVcidReissues = 0;
      clearRingTimer(inst);
      onPhoneNumber(inst, result.phoneNumber);
    }
  });

  serial.on('error', (err) => {
    signale.error(`${tag(inst)} serial port error:`, err.message);
  });

  serial.on('close', () => {
    if (inst.closing) return;
    signale.warn(`${tag(inst)} disconnected unexpectedly`);
    inst.serial = null;
    scheduleReconnect(inst);
  });

  inst.serial = serial;
  startKeepalive(inst);

  // Not awaited: on a silent modem init runs for the whole retry budget, and
  // both startup and POST /settings wait on this call.
  inst.initPromise = runInit(inst, serial).catch((err: Error) =>
    signale.warn(`${tag(inst)} init aborted: ${err.message}`)
  );
};

function scheduleReconnect(inst: ModemInstance) {
  if (inst.isReconnecting || inst.closing) return;
  // Dropped from the registry by a sync in the meantime: don't resurrect it.
  if (registry.get(inst.key) !== inst) return;

  if (inst.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    // Fully tear down the dead instance — otherwise its keepalive interval
    // would keep no-op'ing forever.
    clearTimers(inst);
    signale.error(
      `${tag(inst)} reconnection gave up after ${MAX_RECONNECT_ATTEMPTS} attempts. Restart the service or update settings to retry.`
    );
    return;
  }

  inst.isReconnecting = true;

  const delay = Math.min(
    1000 * Math.pow(2, inst.reconnectAttempt),
    MAX_RECONNECT_DELAY_MS
  );
  signale.info(
    `${tag(inst)} reconnect attempt ${inst.reconnectAttempt + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s...`
  );

  inst.reconnectTimer = setTimeout(async () => {
    inst.reconnectTimer = null;
    if (inst.closing || registry.get(inst.key) !== inst) return;

    try {
      detachPort(inst);
      await openPort(inst);
      inst.reconnectAttempt = 0;
      inst.isReconnecting = false;
      signale.info(`${tag(inst)} reconnected successfully`);
    } catch (err) {
      signale.error(`${tag(inst)} reconnect failed:`, (err as Error).message);
      inst.reconnectAttempt++;
      inst.isReconnecting = false;
      scheduleReconnect(inst);
    }
  }, delay);
}

const closeInstance = async (inst: ModemInstance) => {
  inst.closing = true;
  clearTimers(inst);
  detachPort(inst);
  if (registry.get(inst.key) === inst) registry.delete(inst.key);
  signale.info(`${tag(inst)} closed`);
};

const openInstance = async (settings: IModemSettings) => {
  const inst: ModemInstance = {
    buffer: '',
    closing: false,
    consecutiveVcidReissues: 0,
    initListener: null,
    initPromise: null,
    isReconnecting: false,
    keepalive: null,
    key: settings.port,
    lastNmbrAt: 0,
    lastVcidReissueAt: 0,
    reconnectAttempt: 0,
    reconnectTimer: null,
    ringTimer: null,
    serial: null,
    settings,
  };

  registry.set(inst.key, inst);

  try {
    await openPort(inst);
    signale.info(`${tag(inst)} connected`);
  } catch (err) {
    // Keep the instance registered so the reconnect loop keeps retrying.
    scheduleReconnect(inst);
    throw err;
  }
};

// Reconcile the running modems against the wanted list: untouched ports keep
// their open connection, so saving settings no longer kills every modem.
export const syncModems = async (list: IModemSettings[]): Promise<void> => {
  const wanted = new Map<string, IModemSettings>();

  list.forEach((m) => {
    if (!m.port) {
      signale.warn('Ignoring modem entry without a port');
      return;
    }
    if (wanted.has(m.port)) {
      signale.warn(`Duplicate modem port ${m.port} in settings, ignoring copy`);
      return;
    }
    wanted.set(m.port, m);
  });

  for (const inst of Array.from(registry.values())) {
    // eslint-disable-next-line no-await-in-loop
    if (!wanted.has(inst.key)) await closeInstance(inst);
  }

  for (const [port, cfg] of wanted) {
    const existing = registry.get(port);

    if (existing?.serial?.isOpen || existing?.isReconnecting) {
      existing.settings = cfg;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    if (existing) await closeInstance(existing);

    // One modem that fails to open must not take the others down.
    // eslint-disable-next-line no-await-in-loop
    await openInstance(cfg).catch((err) =>
      signale.error(
        `[modem ${port}] failed to open, continuing:`,
        (err as Error).message
      )
    );
  }
};

export const initModem = async () => {
  const modems = getModems();
  if (!modems.length) return;
  signale.info(`Initializing ${modems.length} modem(s)`);
  await syncModems(modems);
};

// Tests only.
export const __getRegistry = () => registry;
