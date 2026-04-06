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
// eslint-disable-next-line no-unused-vars
let onDataCallback: (data: string) => void;

const KEEPALIVE_INTERVAL_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;

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

const createSerialPort = async (port: string) => {
  const serialport = new SerialPort({
    autoOpen: false,
    baudRate: 9600,
    // path: '/dev/ttyACM0', ---> linux driver writes to this file
    path: port,
  });

  // AT+VCID=1 -> this enables caller id on the modem
  // AT+GCI=B5 -> this changes the setup country (B5 is for USA but caller id is not working with Greece(46))
  serialport.setEncoding('utf-8');

  await new Promise<void>((resolve, reject) => {
    serialport.open((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  await new Promise((resolve) => {
    setTimeout(() => resolve(''), 500);
  });
  serialport.write(Buffer.from('AT+GCI=B5\rAT+VCID=1\r'));

  serialport.on('data', (d: Buffer) => {
    // Example of the data returned when the phone rings
    // RING
    // DATE = 0718\nTIME = 1730\nNMBR = 1234567890
    // RING

    const data = d
      .toString()
      .trim()
      .match(/(?<=NMBR = )\d+/im)?.[0];

    if (data) {
      onDataCallback?.(data);
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
  modem = await createSerialPort(settings.port);
};

export const initModem = async () => {
  if (getSettings().modem?.port) {
    signale.info('Initializing modem');
    await createModem(getSettings().modem!);
  }
};
