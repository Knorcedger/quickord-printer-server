import { Request, Response } from 'express';
import signale from 'signale';

import logger from '../modules/logger';
import { createModem } from '../modules/modem';
import { setupPrinters } from '../modules/printer';
import {
  getSettings,
  IPrinterSettings,
  saveSettings,
  Settings,
  updateSettings,
} from '../modules/settings';

const settings = (req: Request<{}, any, any>, res: Response<{}, any>) => {
  try {
    logger.info('Updating settings:', req.body);

    const oldSettings = getSettings();

    const printers: IPrinterSettings[] = req.body.printers.map(
      (printer: IPrinterSettings) => ({
        ...(oldSettings.printers.find(
          (p) =>
            (p.ip === printer.ip.replace('\r', '') && p.ip !== '') ||
            (p.port === printer.port && p.port !== '')
        ) || {}),
        ...printer,
        ip: printer.ip ? printer.ip.replace('\r', '') : undefined,
      })
    );

    const newSettings = Settings.parse({ ...req.body, printers });

    updateSettings(newSettings);

    saveSettings();
    setupPrinters(newSettings);

    if (newSettings.modem) {
      if (newSettings.modem.port && newSettings.modem.venueId) {
        createModem(newSettings.modem);
      } else {
        signale.warn('Save settings was passed bad data for modem: ', {
          port: newSettings.modem.port,
          venueId: newSettings.modem.venueId,
        });
      }
    }

    logger.info('Settings updated:', newSettings);

    res.status(200).send({ newSettings, status: 'updated' });
  } catch (error) {
    logger.error('Error updating settings:', error);
    res.status(400).send(error.message);
  }
};

export default settings;
