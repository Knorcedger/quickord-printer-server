/* eslint-disable import/prefer-default-export */
import { AutoDetectTypes } from '@serialport/bindings-cpp';
import nconf from 'nconf';
import { SerialPort } from 'serialport';
import signale from 'signale';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { getSettings, IModemSettings } from './settings';
nconf.argv().env().file({ file: './config.json' });
let modem: SerialPort<AutoDetectTypes>;
// eslint-disable-next-line no-unused-vars
let onDataCallback: (data: string) => void;
// eslint-disable-next-line no-unused-vars
let onErrorCallback: (error: Error) => void = () => {};

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

  serialport.open();
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

  serialport.on('error', (d) => {
    onErrorCallback?.(d);
  });

  return serialport;
};

export const createModem = async (settings: IModemSettings) => {
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

      const response = execSync(curlCmd, { encoding: 'utf-8' });
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

  if (modem && modem.path === settings.port) {
    signale.info('Modem already initialized, returning it.');
    return;
  }

  modem = await createSerialPort(settings.port);
};

export const initModem = async () => {
  if (getSettings().modem?.port) {
    signale.info('Initializing modem');
    await createModem(getSettings().modem!);
  }
};
