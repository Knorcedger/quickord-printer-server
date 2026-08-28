import { SerialPort } from 'serialport';
import signale from 'signale';

import { apiCall } from './api';
import { shouldEmit } from './modemDedup';
import { feed } from './modemParser';
import { getModems, getSettings, IModemSettings } from './settings';

const KEEPALIVE_INTERVAL_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;

// Every modem runs as an instance: all state that used to be module-level lives
// here, so a second modem no longer shares the buffer, timers or callback of the
// first one.
type ModemInstance = {
  buffer: string;
  closing: boolean;
  isReconnecting: boolean;
  keepalive: ReturnType<typeof setInterval> | null;
  readonly key: string;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
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

// The modem needs a moment after open before it accepts the init string.
let initDelayMs = 500;
export const __setInitDelayMs = (ms: number) => {
  initDelayMs = ms;
};

const tag = (inst: ModemInstance) =>
  `[modem ${inst.settings.label ? `${inst.settings.label}/` : ''}${inst.key}]`;

const clearTimers = (inst: ModemInstance) => {
  if (inst.keepalive) {
    clearInterval(inst.keepalive);
    inst.keepalive = null;
  }
  if (inst.reconnectTimer) {
    clearTimeout(inst.reconnectTimer);
    inst.reconnectTimer = null;
  }
  inst.isReconnecting = false;
};

const detachPort = (inst: ModemInstance) => {
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

const openPort = async (inst: ModemInstance) => {
  inst.buffer = '';

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

  // AT+VCID=1 -> this enables caller id on the modem
  // AT+GCI=B5 -> this changes the setup country (B5 is for USA but caller id is not working with Greece(46))
  // ATS24=0 -> disables the Conexant sleep-inactivity timer; a sleeping chip
  // misses the CID burst on the first call after long idle (ignored by others)
  serial.write(Buffer.from('AT+GCI=B5\rATS24=0\rAT+VCID=1\r'));

  serial.on('data', (d: Buffer) => {
    const chunk = d.toString();
    signale.debug(`${tag(inst)} raw ${JSON.stringify(chunk)}`);

    const result = feed(inst.buffer, chunk);
    inst.buffer = result.buffer;

    if (result.overflowed) {
      signale.warn(
        `${tag(inst)} Buffer overflow, clearing. Content: ${JSON.stringify(result.overflowed)}`
      );
    }

    if (result.phoneNumber) onPhoneNumber(inst, result.phoneNumber);
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
    isReconnecting: false,
    keepalive: null,
    key: settings.port,
    reconnectAttempt: 0,
    reconnectTimer: null,
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
