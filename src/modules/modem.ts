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
const INIT_CMD_TIMEOUT_MS = 2000;
const INIT_CMD_RETRIES = 5;
const RING_WITHOUT_CID_WARN_MS = 4000;

// Listeners attached during init() to capture OK/ERROR responses to AT commands.
let initResponseListener: ((chunk: string) => void) | null = null;
let ringWithoutCidTimer: ReturnType<typeof setTimeout> | null = null;

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
  initResponseListener = null;
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

const sendInitCommand = (
  port: SerialPort<AutoDetectTypes>,
  cmd: string
): Promise<void> => {
  let attempt = 0;

  const tryOnce = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        initResponseListener = null;
        reject(new Error(`timeout waiting for response to ${cmd.trim()}`));
      }, INIT_CMD_TIMEOUT_MS);

      initResponseListener = (chunk) => {
        if (settled) return;
        if (/\bERROR\b/.test(chunk)) {
          settled = true;
          clearTimeout(timer);
          initResponseListener = null;
          reject(new Error(`modem replied ERROR to ${cmd.trim()}`));
        } else if (/\bOK\b/.test(chunk)) {
          settled = true;
          clearTimeout(timer);
          initResponseListener = null;
          resolve();
        }
      };

      port.write(Buffer.from(`${cmd}\r`), (err) => {
        if (err && !settled) {
          settled = true;
          clearTimeout(timer);
          initResponseListener = null;
          reject(err);
        }
      });
    });

  const attemptLoop = async (): Promise<void> => {
    try {
      await tryOnce();
      signale.info(`[modem] init '${cmd.trim()}' OK`);
    } catch (err) {
      attempt++;
      signale.warn(
        `[modem] init '${cmd.trim()}' attempt ${attempt} failed: ${(err as Error).message}`
      );
      if (attempt >= INIT_CMD_RETRIES) {
        throw new Error(
          `init command '${cmd.trim()}' failed after ${INIT_CMD_RETRIES} attempts`
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

    initResponseListener?.(chunk);

    serialBuffer += chunk;

    if (/\bRING\b/.test(chunk) && !ringWithoutCidTimer) {
      ringWithoutCidTimer = setTimeout(() => {
        ringWithoutCidTimer = null;
        if (!/NMBR/.test(serialBuffer)) {
          signale.warn(
            '[modem] RING received without NMBR (CID block) — VCID may not be enabled'
          );
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
  await new Promise((resolve) => {
    setTimeout(() => resolve(''), 500);
  });

  // Wake the modem first — after a cold PC boot the COM port may enumerate
  // before the modem firmware is ready to process AT commands.
  // AT+GCI=B5 -> setup country (B5/USA; CID does not work with Greece/46)
  // AT+VCID=1 -> enables caller ID
  try {
    await sendInitCommand(serialport, 'AT');
    await sendInitCommand(serialport, 'AT+GCI=B5');
    await sendInitCommand(serialport, 'AT+VCID=1');
  } catch (err) {
    signale.error(`[modem] init failed: ${(err as Error).message}`);
    throw err;
  }

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
