import { Request, Response } from 'express';
import { CharacterSet } from 'node-thermal-printer';

import logger from './modules/logger';
import { getSettings, Settings } from './modules/settings';

const settingsResolver = (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    const newSettings = Settings.parse(req.body);
    const oldSettings = getSettings();

    const updatedFields: string[] = [];

    if (newSettings.printers) {
      oldSettings.printers = newSettings.printers.map((newPrinter) => ({
        ...newPrinter,
        characterSet: CharacterSet[newPrinter.characterSet],
      }));

      updatedFields.push('printers');
    }

    logger.info('Settings updated:', newSettings);

    res.status(200).send({ status: 'updated', updatedFields });
  } catch (error) {
    res.status(400).send(error.message);
  }
};

export default settingsResolver;
