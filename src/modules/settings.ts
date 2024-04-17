import fs from 'fs';
import { CharacterSet } from 'node-thermal-printer';
import { z } from 'zod';

import logger from './logger';

export interface IPrinterSettings {
  categoriesToNotPrint: string[];
  characterSet: CharacterSet;
  ip?: string;
  name: string;
  port?: string;
}

export interface ISettings {
  printers: IPrinterSettings[];
  venueId: string;
}

export const PrinterSettings = z.object({
  categoriesToNotPrint: z.array(z.string()),
  characterSet: z.string(),
  ip: z.string().optional(),
  name: z.string(),
  port: z.string().optional(),
});

export const Settings = z.object({
  printers: z.array(PrinterSettings),
  venueId: z.string(),
});

let settings: ISettings = { printers: [], venueId: '' };

export const loadSettings = async () => {
  try {
    if (!fs.existsSync('./settings.json')) {
      logger.info('Settings file not found. Creating new settings file.');
      fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 2));
      return;
    }

    settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));

    logger.info('Settings loaded:', settings);

    settings.printers = settings.printers?.map((printer) => {
      return {
        ...printer,
        characterSet: CharacterSet[printer.characterSet],
      };
    });
  } catch (error) {
    logger.error('Error reading settings file:', error);
  }
};

export const saveSettings = async () => {
  try {
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 2));
  } catch (error) {
    logger.error('Error writing settings file:', error);
  }
};

export const getSettings = () => {
  return settings;
};
