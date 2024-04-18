/* eslint-disable no-continue */
import {
  printer as ThermalPrinter,
  types as PrinterTypes,
} from 'node-thermal-printer';
import { z } from 'zod';

import { Order } from '../printOrdersResolver';
import logger from './logger';
import { getSettings, IPrinterSettings } from './settings';

const printers: Array<[ThermalPrinter, IPrinterSettings]> = [];

export const setupPrinters = async () => {
  const settings = getSettings();

  settings?.printers?.forEach((printerSettings) => {
    if (!printerSettings.ip && !printerSettings.port) {
      return;
    }

    let interfaceString = printerSettings.port;

    if (printerSettings.ip) {
      interfaceString = `tcp://${printerSettings.ip}`;
    }

    const config: ConstructorParameters<typeof ThermalPrinter>[0] = {
      characterSet: printerSettings.characterSet,
      interface: interfaceString || '',
      options: {
        timeout: 30000,
      },
      type: PrinterTypes.EPSON,
    };

    logger.info(
      `Setting up printer ${printerSettings.name} with config:`,
      config
    );

    printers.push([new ThermalPrinter(config), printerSettings]);
  });
};

export const print = async (order: z.infer<typeof Order>) => {
  const products =
    order?.products?.reduce(
      (acc, product) => {
        return {
          ...acc,
          [product._id || '']:
            product.categories?.map((category) => category._id || '') || [],
        };
      },
      {} as { [key: string]: string[] }
    ) || {};

  for (let i = 0; i < printers.length; i += 1) {
    const printer = printers[i]?.[0];
    const printerSettings = printers[i]?.[1];

    if (!printer) {
      continue;
    }

    order?.products?.filter(
      (product) =>
        // If product has categories, check if they are in the categoriesToNotPrint array
        !products[product._id || '']?.some((category) =>
          printerSettings?.categoriesToNotPrint?.includes(category)
        )
    );

    printer.alignCenter();
    printer.println('ISO8859_7_GREEK');
    printer.println('Καλημέρα Ελλάδα, € 10.00 1234567890');
    printer.cut();

    try {
      printer.execute().then((execute) => {
        logger.info(`Printed order ${order._id}`, execute);
      });
    } catch (error) {
      logger.error('Print failed:', error);
    }
  }
};
