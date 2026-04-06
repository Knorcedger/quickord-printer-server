/* eslint-disable import/prefer-default-export */
import { AutoDetectTypes } from '@serialport/bindings-cpp';
import nconf from 'nconf';
import { SerialPort } from 'serialport';
import signale from 'signale';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { getSettings, IModemSettings } from './settings';
nconf.argv().env().file({ file: './config.json' });

let modem: SerialPort<AutoDetectTypes> | null = null;
let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let isReconnecting = false;
let currentSettings: IModemSettings | null = null;
// eslint-disable-next-line no-unused-vars
let onDataCallback: (data: string) => void;
let serialBuffer = '';

const KEEPALIVE_INTERVAL_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;

const execAsync = (cmd: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf-8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
};

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
  serialBuffer = '';

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
    // Expected modem CID format:
    // RING
    // DATE = 0718
    // TIME = 1730
    // NMBR = 1234567890
    // RING

    const chunk = d.toString();
    // Mask phone digits in raw log to avoid PII exposure
    const maskedChunk = chunk.replace(/(\d{3})\d{4,}/g, '$1****');
    signale.debug(`[modem raw] ${JSON.stringify(maskedChunk)}`);

    serialBuffer += chunk;

    // Process buffer when we have a complete message:
    // Either a second RING (end of CID block) or a newline after NMBR line
    const hasCompleteNmbr = /NMBR\s*=\s*\+?\d+/.test(serialBuffer) &&
      (serialBuffer.indexOf('NMBR') < serialBuffer.lastIndexOf('\n') ||
       (serialBuffer.match(/RING/g)?.length ?? 0) >= 2);

    if (hasCompleteNmbr) {
      const phoneNumber = serialBuffer.match(/(?<=NMBR\s*=\s*)\+?\d+/im)?.[0];

      if (phoneNumber) {
        onDataCallback?.(phoneNumber);
      }

      serialBuffer = '';
    }

    // Prevent buffer from growing indefinitely if no NMBR arrives
    if (serialBuffer.length > 1024) {
      signale.warn(`[modem] Buffer overflow, clearing. Content: ${JSON.stringify(serialBuffer)}`);
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

  startKeepalive();

  return serialport;
};

export const createModem = async (settings: IModemSettings) => {
  currentSettings = settings;

  // this sends the data to our BE every time a call happens
  // TODO: this should be done locally instead of through the quickordBE
  onDataCallback = async (data) => {
    signale.info(`Phone call detected: ${data}`);
    let tempFilePath: string | null = null;
    try {
      signale.info(
        `Sending phone info to BE: phoneNumber: "${data}", venueId:"${settings.venueId}"`
      );

      const graphqlQuery = {
        query: `mutation {
    incomingPhoneCall(phoneNumber: "${data}", venueId:"${settings.venueId}"){
    status
    }
    }`,
      };

      // Write payload to temp file to avoid escaping issues on Windows
      tempFilePath = path.join(os.tmpdir(), `modem-payload-${Date.now()}.json`);
      fs.writeFileSync(tempFilePath, JSON.stringify(graphqlQuery));

      // Use curl to bypass SSL issues in bundled executable
      const curlCmd = `curl -s -X POST "${nconf.get('QUICKORD_API_URL')}" -H "Content-Type: application/json" -H "apikey: desktop_H2WRdpoSEh7iOWD2iCZD7msTKOs" -H "appId: desktop" --data-binary "@${tempFilePath}"`;

      const response = await execAsync(curlCmd);
      const responseJson = JSON.parse(response);

      if (responseJson?.errors) {
        signale.error(
          'failed to call BE for phonecall',
          JSON.stringify(responseJson.errors, null, 2)
        );
      } else {
        signale.info(`Phone info sent`);
      }
    } catch (err) {
      signale.error('error sending phone data to BE');
      signale.error(err);
    } finally {
      // Clean up temp file
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupErr) {
          // Ignore cleanup errors
        }
      }
    }
  };
  
  if (modem && modem.isOpen && modem.path === settings.port) {
    signale.info('Modem already connected on same port, keeping existing connection.');
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
