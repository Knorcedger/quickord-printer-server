import fs from 'node:fs';
import { CharacterSet } from 'node-thermal-printer';
import { z } from 'zod';

import logger from './logger.ts';

const CharacterSetEnum = z.nativeEnum(CharacterSet);

export const PrinterTextSize = z.enum(['NORMAL', 'ONE', 'TWO', 'THREE']);

export const PrinterSettings = z.object({
  categoriesToNotPrint: z.any(),
  characterSet: CharacterSetEnum,
  copies: z.number().int().default(1),
  ip: z.string().ip({ version: 'v4' }),
  name: z.string().optional(),
  networkName: z.string(),
  port: z.string().optional(),
  textSize: PrinterTextSize.optional().default('NORMAL'),
});

export type IPrinterSettings = z.infer<typeof PrinterSettings>;

export const Settings = z.object({
  printers: z.array(PrinterSettings),
});

export type ISettings = z.infer<typeof Settings>;

let settings: ISettings = { printers: [] };

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

export const updateSettings = (newSettings: ISettings) => {
  settings = newSettings;
};
