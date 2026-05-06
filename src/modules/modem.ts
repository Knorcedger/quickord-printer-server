/* eslint-disable import/prefer-default-export */
import { AutoDetectTypes } from '@serialport/bindings-cpp';
import { SerialPort } from 'serialport';
import signale from 'signale';

import { apiCall } from './api';
import { getSettings, IModemSettings } from './settings';

let modem: SerialPort<AutoDetectTypes> | null = null;
let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let isReconnecting = false;
let currentSettings: IModemSettings | null = null;
let onDataCallback: (data: string) => void;
let serialBuffer = '';

const KEEPALIVE_INTERVAL_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;
const INIT_CMD_TIMEOUT_MS = 3000;
const INIT_CMD_RETRIES = 5;
const RING_WITHOUT_CID_WARN_MS = 4000;
const POST_OPEN_DRAIN_MS = 1500;

// Listener attached during init to capture chunks for OK/ERROR detection.
let initChunkListener: ((chunk: string) => void) | null = null;
let ringWithoutCidTimer: ReturnType<typeof setTimeout> | null = null;
let lastNmbrAt = 0;
let consecutiveVcidReissues = 0;
const RECENT_NMBR_WINDOW_MS = 30_000;

const cleanup = () => {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  isReconnecting = false;
  reconnectAttempt = 0;
  initChunkListener = null;
  consecutiveVcidReissues = 0;
  if (ringWithoutCidTimer) {
    clearTimeout(ringWithoutCidTimer);
    ringWithoutCidTimer = null;
  }

  if (modem) {
    modem.removeAllListeners(); // Remove listeners BEFORE close to prevent triggering reconnect
    if (modem.isOpen) {
      modem.close();
    }
    modem = null;
  }
};

const scheduleReconnect = () => {
  if (isReconnecting || !currentSettings) return;

  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    signale.error(
      `Modem reconnection gave up after ${MAX_RECONNECT_ATTEMPTS} attempts. Restart the service or update settings to retry.`
    );
    return;
  }

  isReconnecting = true;

  const delay = Math.min(
    1000 * Math.pow(2, reconnectAttempt),
    MAX_RECONNECT_DELAY_MS
  );
  signale.info(
    `Modem reconnect attempt ${reconnectAttempt + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s...`
  );

  reconnectTimer = setTimeout(async () => {
    try {
      // Clean up old port before reconnecting
      if (modem) {
        modem.removeAllListeners(); // Remove listeners BEFORE close to prevent triggering reconnect
        if (modem.isOpen) {
          modem.close();
        }
        modem = null;
      }

      modem = await createSerialPort(currentSettings!.port);
      reconnectAttempt = 0;
      isReconnecting = false;
      signale.info('Modem reconnected successfully');
    } catch (err) {
      signale.error('Modem reconnect failed:', (err as Error).message);
      reconnectAttempt++;
      isReconnecting = false;
      scheduleReconnect();
    }
  }, delay);
};

const startKeepalive = () => {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
  }
  keepaliveInterval = setInterval(() => {
    if (!modem || !modem.isOpen) return;
    modem.write('AT\r', (err) => {
      if (err) {
        signale.error('Modem keepalive failed:', err.message);
        scheduleReconnect();
      }
    });
  }, KEEPALIVE_INTERVAL_MS);
};

const reissueVcid = (reason: string) => {
  if (!modem || !modem.isOpen) return;
  consecutiveVcidReissues++;
  signale.info(`[modem] re-issuing AT+VCID=1 (${reason})`);
  if (consecutiveVcidReissues >= 2) {
    signale.error(
      `[modem] VCID re-issue triggered ${consecutiveVcidReissues}x in a row — previous reissue may have failed silently`
    );
  }
  modem.write('AT+VCID=1\r', (err) => {
    if (err) signale.error('[modem] reissue VCID write failed:', err.message);
  });
};

// Send an init AT command and wait for an OK/ERROR that follows the echoed
// command in the response stream. Echo-matching guards against false-positive
// OKs from stale boot-time output already buffered when we attach our listener.
const sendInitCommand = (
  port: SerialPort<AutoDetectTypes>,
  cmd: string
): Promise<void> => {
  let attempt = 0;
  const cmdTrim = cmd.trim();
  // Anchor echo match to line start + line terminator so e.g. residual "ATE1"
  // echo doesn't false-match an "AT" command.
  const echoRegex = new RegExp(
    `(?:^|[\\r\\n])${cmdTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\r|\\n)`
  );

  const tryOnce = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      let buf = '';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        initChunkListener = null;
        reject(
          new Error(
            `timeout waiting for echo+OK to ${cmdTrim} (got: ${JSON.stringify(buf)})`
          )
        );
      }, INIT_CMD_TIMEOUT_MS);

      initChunkListener = (chunk) => {
        if (settled) return;
        buf += chunk;
        const echoMatch = echoRegex.exec(buf);
        if (!echoMatch) return; // wait until we've seen our command echoed back
        const after = buf.slice(echoMatch.index + echoMatch[0].length);
        if (/\bERROR\b/.test(after)) {
          settled = true;
          clearTimeout(timer);
          initChunkListener = null;
          reject(new Error(`modem replied ERROR to ${cmdTrim}`));
        } else if (/\bOK\b/.test(after)) {
          settled = true;
          clearTimeout(timer);
          initChunkListener = null;
          resolve();
        }
      };

      signale.info(`[modem] init -> ${cmdTrim}`);
      port.write(Buffer.from(`${cmd}\r`), (err) => {
        if (err && !settled) {
          settled = true;
          clearTimeout(timer);
          initChunkListener = null;
          reject(err);
        }
      });
    });

  const attemptLoop = async (): Promise<void> => {
    try {
      await tryOnce();
      signale.info(`[modem] init '${cmdTrim}' OK`);
    } catch (err) {
      attempt++;
      signale.warn(
        `[modem] init '${cmdTrim}' attempt ${attempt} failed: ${(err as Error).message}`
      );
      if (attempt >= INIT_CMD_RETRIES) {
        throw new Error(
          `init command '${cmdTrim}' failed after ${INIT_CMD_RETRIES} attempts`
        );
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
      return attemptLoop();
    }
  };

  return attemptLoop();
};

const createSerialPort = async (port: string) => {
  serialBuffer = '';

  const serialport = new SerialPort({
    autoOpen: false,
    baudRate: 9600,
    // path: '/dev/ttyACM0', ---> linux driver writes to this file
    path: port,
  });

  serialport.setEncoding('utf-8');

  serialport.on('data', (d: Buffer) => {
    // Expected modem CID formats:
    // Direct modem:          CHC (virtual COM):
    // RING                   RING
    // DATE = 0718            DATE 0408
    // TIME = 1730            TIME 1355
    // NMBR = 1234567890      NMBR 6976641604
    // RING

    const chunk = d.toString();
    signale.debug(`[modem raw] ${JSON.stringify(chunk)}`);

    initChunkListener?.(chunk);

    serialBuffer += chunk;

    // The CID block (DATE/TIME/NMBR) is sent only once, between the first and
    // second RING. Subsequent RINGs of the same call legitimately have no NMBR,
    // so suppress the warning if we received one recently.
    const recentNmbr = Date.now() - lastNmbrAt < RECENT_NMBR_WINDOW_MS;
    if (/\bRING\b/.test(chunk) && !ringWithoutCidTimer && !recentNmbr) {
      ringWithoutCidTimer = setTimeout(() => {
        ringWithoutCidTimer = null;
        if (
          !/NMBR/.test(serialBuffer) &&
          Date.now() - lastNmbrAt >= RECENT_NMBR_WINDOW_MS
        ) {
          signale.warn(
            '[modem] RING received without NMBR (CID block) — VCID may not be enabled'
          );
          reissueVcid('RING without NMBR');
        }
      }, RING_WITHOUT_CID_WARN_MS);
    }

    // Process buffer when we have a complete message:
    // Either a second RING (end of CID block) or a newline after NMBR line
    const hasCompleteNmbr =
      /NMBR\s*=?\s*\+?\d+/.test(serialBuffer) &&
      (serialBuffer.indexOf('NMBR') < serialBuffer.lastIndexOf('\n') ||
        (serialBuffer.match(/RING/g)?.length ?? 0) >= 2);

    if (hasCompleteNmbr) {
      const phoneNumber = serialBuffer.match(/(?<=NMBR\s*=?\s*)\+?\d+/im)?.[0];

      if (phoneNumber) {
        lastNmbrAt = Date.now();
        consecutiveVcidReissues = 0;
        onDataCallback?.(phoneNumber);
      }

      serialBuffer = '';
      if (ringWithoutCidTimer) {
        clearTimeout(ringWithoutCidTimer);
        ringWithoutCidTimer = null;
      }
    }

    // Prevent buffer from growing indefinitely if no NMBR arrives
    if (serialBuffer.length > 1024) {
      signale.warn(
        `[modem] Buffer overflow, clearing. Content: ${JSON.stringify(serialBuffer)}`
      );
      serialBuffer = '';
    }
  });

  serialport.on('error', (err) => {
    signale.error('Modem serial port error:', err.message);
  });

  serialport.on('close', () => {
    signale.warn('Modem disconnected unexpectedly');
    modem = null;
    scheduleReconnect();
  });

  await new Promise<void>((resolve, reject) => {
    serialport.open((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Drain any boot-time / leftover output from the modem so it doesn't get
  // mistaken for a response to our init commands.
  let drained = '';
  const drainListener = (chunk: string) => {
    drained += chunk;
  };
  initChunkListener = drainListener;
  await new Promise((resolve) => {
    setTimeout(() => resolve(''), POST_OPEN_DRAIN_MS);
  });
  initChunkListener = null;
  if (drained.length) {
    signale.info(
      `[modem] drained pre-init output: ${JSON.stringify(drained.slice(0, 256))}`
    );
  }
  // The data handler kept appending to serialBuffer while draining; reset it
  // so init responses don't get mixed with stale data when looking for NMBR.
  serialBuffer = '';

  // ATE1 fire-and-forget: the rest of init relies on echo-matching, so we
  // must force echo on first. Can't use sendInitCommand here because if the
  // modem booted with ATE0 it won't echo "ATE1" back and we'd timeout waiting
  // for the echo. Just write + drain briefly; subsequent commands will verify
  // echo is on by virtue of their own echo-matching.
  signale.info('[modem] init -> ATE1 (fire-and-forget)');
  serialport.write('ATE1\r');
  await new Promise((resolve) => setTimeout(resolve, 200));

  // AT       -> wake/sanity check
  // AT+GCI=B5 -> setup country (B5/USA; CID does not work with Greece/46)
  // AT+VCID=1 -> enables caller ID
  // Failures are logged but non-fatal: some older modems (e.g. AD102) may not
  // support AT+GCI, and on others VCID is already persisted in NVRAM. Keeping
  // the port open lets call detection still work; the runtime
  // RING-without-NMBR watchdog will re-issue VCID if needed.
  const trySoft = async (cmd: string) => {
    try {
      await sendInitCommand(serialport, cmd);
    } catch (err) {
      signale.warn(
        `[modem] init '${cmd}' did not complete: ${(err as Error).message} — continuing anyway`
      );
    }
  };
  await trySoft('AT');
  await trySoft('AT+GCI=B5');
  await trySoft('AT+VCID=1');

  startKeepalive();

  return serialport;
};

export const createModem = async (settings: IModemSettings) => {
  currentSettings = settings;

  // this sends the data to our BE every time a call happens
  // TODO: this should be done locally instead of through the quickordBE
  onDataCallback = async (data) => {
    signale.info(`Phone call detected: ${data}`);
    try {
      signale.info(
        `Sending phone info to BE: phoneNumber: "${data}", venueId:"${settings.venueId}"`
      );

      const response = await apiCall(
        `mutation { incomingPhoneCall(phoneNumber: "${data}", venueId:"${settings.venueId}") { status } }`
      );

      if (response?.errors) {
        signale.error(
          'failed to call BE for phonecall',
          JSON.stringify(response.errors, null, 2)
        );
      } else {
        signale.info(`Phone info sent`);
      }
    } catch (err) {
      signale.error('error sending phone data to BE');
      signale.error(err);
    }
  };

  if (modem && modem.isOpen && modem.path === settings.port) {
    signale.info(
      'Modem already connected on same port, keeping existing connection.'
    );
    return;
  }

  cleanup();
  serialBuffer = '';
  modem = await createSerialPort(settings.port);
};

export const initModem = async () => {
  if (getSettings().modem?.port) {
    signale.info('Initializing modem');
    await createModem(getSettings().modem!);
  }
};
