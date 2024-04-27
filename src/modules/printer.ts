/* eslint-disable no-continue */
import {
  CharacterSet,
  printer as ThermalPrinter,
  types as PrinterTypes,
} from 'node-thermal-printer';
import { z } from 'zod';

import { Order } from '../resolvers/printOrders.ts';
import logger from './logger.ts';
import { getSettings, IPrinterSettings } from './settings.ts';

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

export const testUsbPrint = async () => {
  const printer = new ThermalPrinter({
    characterSet: CharacterSet.ISO8859_7_GREEK,
    driver: 'printer',
    interface: 'usb',
    type: PrinterTypes.EPSON,
  });

  printer.alignCenter();
  printer.println('ISO8859_7_GREEK');
  printer.println('Καλημέρα Ελλάδα, € 10.00 1234567890');
  printer.cut();

  try {
    await printer.execute();

    logger.info('Printed test page to usb');
  } catch (error) {
    logger.error('Print failed:', error);
  }
};

export const printTestPage = async <HasBuffer extends boolean>(
  ip: string,
  charset?: CharacterSet,
  getBuffer?: HasBuffer
): Promise<string | Buffer> => {
  const printer = new ThermalPrinter({
    characterSet: charset || CharacterSet.ISO8859_7_GREEK,
    interface: `tcp://${ip}`,
    type: PrinterTypes.EPSON,
  });

  printer.alignCenter();
  printer.println(`charset: ${charset || CharacterSet.ISO8859_7_GREEK}`);
  printer.println(`ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω`);
  printer.println('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
  printer.println(',.!?;"€$@#*&%[]{}\\|+-<>/1234567890');
  printer.setTextNormal();
  printer.println('text normal');
  printer.setTextSize(1, 1);
  printer.println('text size 1');
  printer.setTextSize(2, 2);
  printer.println('text size 2');
  printer.setTextSize(3, 3);
  printer.println('text size 3');
  printer.cut();

  if (getBuffer === true) {
    return printer.getBuffer();
  }

  try {
    await printer.execute();
    logger.info(`Printed test page to ${ip}`);

    return 'success';
  } catch (error) {
    logger.error('Print failed:', error);
    throw new Error('print failed', {
      cause: error,
    });
  }
};

export const printOrder = async (order: z.infer<typeof Order>) => {
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

    const productsToPrint = order?.products?.filter(
      (product) =>
        // If product has categories, check if they are in the categoriesToNotPrint array
        !products[product._id || '']?.some((category) =>
          printerSettings?.categoriesToNotPrint?.includes(category)
        )
    );

    if (!productsToPrint?.length) {
      continue;
    }

    printer.alignCenter();
    printer.println('ISO8859_7_GREEK');
    printer.println('Καλημέρα Ελλάδα, € 10.00 1234567890');
    printer.cut();

    try {
      printer.execute().then(() => {
        logger.info(`Printed order ${order._id}`);
      });
    } catch (error) {
      logger.error('Print failed:', error);
    }
  }
};
