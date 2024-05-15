import { Request, Response } from 'express';

import logger from '../modules/logger.ts';
import { setupPrinters } from '../modules/printer.ts';
import { saveSettings, Settings, updateSettings } from '../modules/settings.ts';

const settings = (req: Request<{}, any, any>, res: Response<{}, any>) => {
  try {
    logger.info('Updating settings:', req.body);
    const newSettings = Settings.parse(req.body?.replace(/\r/g, ''));

    updateSettings(newSettings);

    saveSettings();
    setupPrinters(newSettings);

    logger.info('Settings updated:', newSettings);

    res.status(200).send({ newSettings, status: 'updated' });
  } catch (error) {
    logger.error('Error updating settings:', error);
    res.status(400).send(error.message);
  }
};

export default settings;
