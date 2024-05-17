import fs from 'node:fs';
import { CharacterSet } from 'node-thermal-printer';
import { z } from 'zod';

import logger from './logger.ts';

const CharacterSetEnum = z.nativeEnum(CharacterSet, {
  description: 'The character set to use for the printer.',
  invalid_type_error: 'characterSet must be a valid CharacterSet.',
  required_error: 'characterSet is required.',
});

export const PrinterTextSize = z.enum(['NORMAL', 'ONE', 'TWO', 'THREE'], {
  description: 'The text size to use for the printer. Defaults to NORMAL.',
  invalid_type_error: 'textSize must be a valid PrinterTextSize.',
  required_error: 'textSize is required.',
});

export const PrinterTextOptions = z.enum(['BOLD_PRODUCTS'], {
  description: 'The text options to use for the printer.',
  invalid_type_error: 'textOptions must be a valid PrinterTextOptions.',
  required_error: 'textOptions is required.',
});

export const PrinterSettings = z.object({
  categoriesToNotPrint: z
    .array(z.string(), {
      description: 'The product categories to not print on the receipt.',
      invalid_type_error: 'categoriesToNotPrint must be an array of strings.',
      required_error: 'categoriesToNotPrint is required.',
    })
    .optional()
    .default([]),
  characterSet: CharacterSetEnum,
  codePage: z
    .number({
      invalid_type_error: 'codePage must be a number.',
    })
    .optional()
    .default(17),
  copies: z
    .number({
      invalid_type_error: 'copies must be a number.',
      required_error: 'copies is required.',
    })
    .int({
      message: 'copies must be an integer.',
    })
    .default(1),
  ip: z
    .string({
      description: 'The IP address of the printer.',
      invalid_type_error: 'ip must be a valid IPv4 address.',
      required_error: 'ip is required.',
    })
    .optional()
    .default(''),
  name: z
    .string({
      invalid_type_error: 'printer name must be a string.',
      required_error: 'printer name is required.',
    })
    .optional()
    .default(''),
  networkName: z.string({
    invalid_type_error: 'printer networkName must be a string.',
    required_error: 'printer networkName is required.',
  }),
  port: z
    .string({
      invalid_type_error: 'printer port must be a string.',
    })
    .optional()
    .default(''),
  textOptions: z
    .array(PrinterTextOptions, {
      description: 'The text options to use for the printer.',
      invalid_type_error: 'textOptions must be an array of PrinterTextOptions.',
      required_error: 'textOptions is required.',
    })
    .optional()
    .default([]),
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
        characterSet:
          CharacterSet[printer.characterSet] || CharacterSet.WPC1253_GREEK,
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
