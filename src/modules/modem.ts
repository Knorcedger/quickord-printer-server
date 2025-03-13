import { AutoDetectTypes } from '@serialport/bindings-cpp';
import { SerialPort } from 'serialport';
import { getSettings, IModemSettings } from './settings.ts';
import signale from 'signale';
import nconf from 'nconf';

let modem: SerialPort<AutoDetectTypes>;
// eslint-disable-next-line no-unused-vars
let onDataCallback: (data: string) => void;
// eslint-disable-next-line no-unused-vars
let onErrorCallback: (error: Error) => void;

export const createModem = async (settings: IModemSettings) => {
  onDataCallback = async (data) => {
    signale.info(`Phone call detected: ${data}`);
    try {
      signale.info(
        `Sending phone info to BE: phoneNumber: "${data}", venueId:"${settings.venueId}"`
      );
      const res = await fetch(nconf.get('QUICKORD_API_URL'), {
        body: JSON.stringify({
          query: `mutation {
    incomingPhoneCall(phoneNumber: "${data}", venueId:"${settings.venueId}"){
    status
    }
    }`,
        }),
        headers: {
          'Content-Type': 'application/json',
          apiKey: 'referral_web_qm2ebaEWL48WHjh23bNi9ZRhiaVI0jT9',
          appId: 'referral',
        },
        method: 'POST',
      });

      const responseJson = (await res.json()) as any;

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
    }
  };
  // need to rebuild
  // if (modem && modem.path === settings.port) {
  // signale.info('Modem already initialized, returning it.');
  //return;
  //}

  //modem = await createSerialPort(settings.port);
};
export const initModem = async () => {
  if (getSettings().modem?.port) {
    signale.info('Initializing modem');
    await createModem(getSettings().modem!);
  }
};
