/* eslint-disable no-continue */
import {
  CharacterSet,
  printer as ThermalPrinter,
  types as PrinterTypes,
} from 'node-thermal-printer';
import { transliterate } from 'transliteration';
import { z } from 'zod';

import { Order } from '../resolvers/printOrders.ts';
import { convertToDecimal, leftPad } from './common.ts';
import logger from './logger.ts';
import { IPrinterSettings, ISettings } from './settings.ts';
import { SupportedLanguages, translations } from './translations.ts';

const printers: Array<[ThermalPrinter, IPrinterSettings]> = [];

export const setupPrinters = async (settings: ISettings) => {
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

export const printTestPage = async (
  ip: string,
  charset?: CharacterSet
): Promise<string> => {
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

export const printOrder = async (
  order: z.infer<typeof Order>,
  lang: SupportedLanguages = 'el'
) => {
  for (let i = 0; i < printers.length; i += 1) {
    const printer = printers[i]?.[0];
    const settings = printers[i]?.[1];

    if (!printer) {
      continue;
    }

    const productsToPrint = order.products.filter((product) =>
      product.categories.some((category) =>
        settings?.categoriesToNotPrint?.includes(category)
      )
    );

    const orderCreationDate = new Date(order.createdAt);
    const date =
      orderCreationDate.toISOString().split('T')[0]?.replaceAll('-', '/') || '';

    const time = orderCreationDate.toLocaleTimeString('el-GR', {
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
    });

    printer.alignCenter();
    printer.println(transliterate(translations.printOrder.orderForm[lang]));
    printer.alignLeft();
    printer.newLine();
    printer.println(transliterate(order.venue.title));
    printer.println(transliterate(order.venue.address));
    printer.drawLine();
    printer.table([
      date,
      time,
      transliterate(
        `${translations.printOrder.orderNumber[lang]}:#${order.number}`
      ),
    ]);
    printer.println(
      transliterate(
        `${translations.printOrder.orderType[lang]}: ${translations.printOrder.orderTypes[order.orderType][lang]}`
      )
    );
    printer.println(
      transliterate(
        `${translations.printOrder.paymentType[lang]}: ${translations.printOrder.paymentTypes[order.paymentType][lang]}`
      )
    );
    printer.drawLine();

    if (order.orderType === 'DELIVERY' && order.deliveryInfo) {
      printer.println(
        transliterate(
          `${translations.printOrder.customerName[lang]}: ${order.deliveryInfo.customerName}`
        )
      );
      printer.println(
        transliterate(
          `${translations.printOrder.deliveryAddress[lang]}: ${order.deliveryInfo.customerAddress}`
        )
      );
      printer.println(
        transliterate(
          `${translations.printOrder.deliveryFloor[lang]}: ${order.deliveryInfo.customerFloor}`
        )
      );
      printer.println(
        transliterate(
          `${translations.printOrder.deliveryBell[lang]}: ${order.deliveryInfo.customerBell}`
        )
      );
      printer.println(
        transliterate(
          `${translations.printOrder.deliveryPhone[lang]}: ${order.deliveryInfo.customerPhoneNumber}`
        )
      );
    } else if (
      (order.orderType === 'TAKE_AWAY_INSIDE' ||
        order.orderType === 'TAKE_AWAY_PACKAGE') &&
      order.TakeAwayInfo
    ) {
      printer.println(
        transliterate(
          `${translations.printOrder.customerName[lang]}: ${order.TakeAwayInfo.customerName}`
        )
      );
      printer.println(
        transliterate(
          `${translations.printOrder.customerEmail[lang]}: ${order.TakeAwayInfo.customerEmail}`
        )
      );
    }

    printer.drawLine();
    productsToPrint.forEach((product) => {
      printer.newLine();
      const leftAmount = `${product.quantity}x `.length;
      printer.println(transliterate(`${product.quantity}x ${product.title}`));
      product.choices?.forEach((choice) => {
        printer.println(
          leftPad(transliterate(`${choice.title}`), leftAmount, ' ')
        );
      });
      printer.alignRight();
      printer.println(
        transliterate(`${convertToDecimal(product.total).toFixed(2)} E`)
      );
      printer.alignLeft();
    });
    printer.newLine();
    printer.println(
      transliterate(
        `${translations.printOrder.waiterComments[lang]}: ${order.waiterComment}`
      )
    );
    printer.newLine();
    printer.println(
      transliterate(
        `${translations.printOrder.customerComments[lang]}: ${order.customerComment}`
      )
    );
    printer.drawLine();

    if (order.tip) {
      printer.newLine();
      printer.println(
        transliterate(
          `${translations.printOrder.tip[lang]}: ${convertToDecimal(order.tip).toFixed(2)} ${order.currency}`
        )
      );
    }

    if (order.deliveryInfo?.deliveryFee) {
      printer.newLine();
      printer.println(
        transliterate(
          `${translations.printOrder.deliveryFee[lang]}: ${convertToDecimal(order.deliveryInfo.deliveryFee).toFixed(2)} ${order.currency}`
        )
      );
    }

    printer.newLine();
    printer.alignRight();
    printer.println(
      transliterate(
        `${translations.printOrder.total[lang]}: ${convertToDecimal(order.total).toFixed(2)} ${order.currency}`
      )
    );
    printer.newLine();
    printer.println(transliterate(translations.printOrder.poweredBy[lang]));
    printer.newLine();
    printer.newLine();
    printer.alignCenter();
    printer.println(
      transliterate(translations.printOrder.notReceiptNotice[lang])
    );
    printer.cut();

    try {
      // eslint-disable-next-line no-await-in-loop
      await printer.execute();
      logger.info(
        `Printed test page to ${settings?.name || settings?.networkName}:${settings?.ip || settings?.port}`
      );
    } catch (error) {
      logger.error('Print failed:', error);
    }
  }
};

export const printOrders = async (orders: z.infer<typeof Order>[]) => {
  orders.forEach(async (order) => {
    printOrder(order);
  });
};
