/* eslint-disable no-await-in-loop */
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
import {
  getSettings,
  IPrinterSettings,
  ISettings,
  PrinterTextSize,
} from './settings.ts';
import { SupportedLanguages, translations } from './translations.ts';

const changeTextSize = (
  printer: ThermalPrinter,
  size: z.infer<typeof PrinterTextSize>
) => {
  switch (size) {
    case 'ONE':
      printer.setTextSize(1, 1);
      return;
    case 'TWO':
      printer.setTextSize(2, 2);
      return;
    case 'THREE':
      printer.setTextSize(3, 3);
      return;
    case 'NORMAL':
    default:
      printer.setTextNormal();
  }
};

export const setupPrinters = async (settings: ISettings) => {
  const printers: [ThermalPrinter, IPrinterSettings][] = [];

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
      type: PrinterTypes.EPSON,
    };

    logger.info(
      `Setting up printer ${printerSettings.name} with config:`,
      config
    );

    printers.push([
      new ThermalPrinter({
        characterSet: printerSettings.characterSet,
        interface: interfaceString || '',
        type: PrinterTypes.EPSON,
      }),
      printerSettings,
    ]);
  });

  return printers;
};

export const setupPrinter = (settings: IPrinterSettings) => {
  if (!settings.ip && !settings.port) {
    return null;
  }

  let interfaceString = settings.port;

  if (settings.ip) {
    interfaceString = `tcp://${settings.ip}`;
  }

  const config: ConstructorParameters<typeof ThermalPrinter>[0] = {
    characterSet:
      CharacterSet[settings.characterSet] || CharacterSet.ISO8859_7_GREEK,
    interface: interfaceString || '',
    type: PrinterTypes.EPSON,
  };

  logger.info(`Setting up printer ${settings.name} with config:`, config);

  return new ThermalPrinter(config);
};

export const printTestPage = async (
  ip: string,
  charset?: CharacterSet
): Promise<string> => {
  const printer = new ThermalPrinter({
    characterSet: charset || CharacterSet.WPC1253_GREEK,
    interface: `tcp://${ip}`,
    type: PrinterTypes.EPSON,
  });

  printer.alignCenter();
  printer.println(`charset: ${charset || CharacterSet.WPC1253_GREEK}`);
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
  const printers = await setupPrinters(getSettings());

  for (let i = 0; i < printers.length; i += 1) {
    try {
      const settings = printers[i]?.[1];

      if (!settings) {
        continue;
      }

      if (!settings.ip && !settings.port) {
        continue;
      }

      const printer = new ThermalPrinter({
        characterSet: settings.characterSet || CharacterSet.WPC1253_GREEK,
        interface: `tcp://${settings.ip}`,
        type: PrinterTypes.EPSON,
      });

      const productsToPrint = order.products.filter((product) =>
        product.categories.some(
          (category) => !settings?.categoriesToNotPrint?.includes(category)
        )
      );

      if (!productsToPrint?.length) {
        continue;
      }

      const orderCreationDate = new Date(order.createdAt);
      const date =
        orderCreationDate.toISOString().split('T')[0]?.replaceAll('-', '/') ||
        '';

      const time = orderCreationDate.toLocaleTimeString('el-GR', {
        hour: '2-digit',
        hour12: false,
        minute: '2-digit',
      });

      printer.clear();
      changeTextSize(printer, settings?.textSize || 'NORMAL');

      printer.drawLine();
      printer.newLine();
      printer.alignCenter();
      printer.println(
        transliterate(`${translations.printOrder.orderForm[lang]}`)
      );
      printer.alignLeft();
      printer.newLine();
      printer.println(transliterate(order.venue.title));
      printer.println(transliterate(order.venue.address));
      printer.drawLine();
      printer.table([
        `${date}`,
        `${time}`,
        transliterate(
          `${translations.printOrder.orderNumber[lang]}:#${order.number}`
        ),
      ]);

      if (order?.tableNumber) {
        printer.table([
          transliterate(
            `${translations.printOrder.tableNumber[lang]}:${order.tableNumber}`
          ),
          ...(order.waiterName
            ? [
                transliterate(
                  `${translations.printOrder.waiter[lang]}:${order.waiterName}`
                ),
              ]
            : []),
        ]);
      }

      printer.println(
        transliterate(
          `${translations.printOrder.orderType[lang]}:${translations.printOrder.orderTypes[order.orderType][lang]}`
        )
      );
      printer.println(
        transliterate(
          `${translations.printOrder.paymentType[lang]}:${translations.printOrder.paymentTypes[order.paymentType][lang]}`
        )
      );
      printer.drawLine();

      if (order.orderType === 'DELIVERY' && order.deliveryInfo) {
        printer.println(
          transliterate(
            `${translations.printOrder.customerName[lang]}:${order.deliveryInfo.customerName}`
          )
        );
        printer.println(
          transliterate(
            `${translations.printOrder.deliveryAddress[lang]}:${order.deliveryInfo.customerAddress}`
          )
        );
        printer.println(
          transliterate(
            `${translations.printOrder.deliveryFloor[lang]}:${order.deliveryInfo.customerFloor}`
          )
        );
        printer.println(
          transliterate(
            `${translations.printOrder.deliveryBell[lang]}:${order.deliveryInfo.customerBell}`
          )
        );
        printer.println(
          transliterate(
            `${translations.printOrder.deliveryPhone[lang]}:${order.deliveryInfo.customerPhoneNumber}`
          )
        );
      } else if (
        (order.orderType === 'TAKE_AWAY_INSIDE' ||
          order.orderType === 'TAKE_AWAY_PACKAGE') &&
        order.TakeAwayInfo
      ) {
        printer.println(
          transliterate(
            `${translations.printOrder.customerName[lang]}:${order.TakeAwayInfo.customerName}`
          )
        );
        printer.println(
          transliterate(
            `${translations.printOrder.customerEmail[lang]}:${order.TakeAwayInfo.customerEmail}`
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
            transliterate(leftPad(`${choice.title}`, leftAmount, ' '))
          );
        });
        printer.alignRight();
        printer.println(
          transliterate(`${convertToDecimal(product.total).toFixed(2)} E`)
        );
        printer.alignLeft();
      });

      if (order.waiterComment) {
        printer.newLine();
        printer.println(
          transliterate(
            `${translations.printOrder.waiterComments[lang]}:${order.waiterComment}`
          )
        );
      }

      if (order.customerComment) {
        printer.newLine();
        printer.println(
          transliterate(
            `${translations.printOrder.customerComments[lang]}:${order.customerComment}`
          )
        );
      }

      printer.drawLine();

      if (order.tip) {
        printer.newLine();
        printer.println(
          transliterate(
            `${translations.printOrder.tip[lang]}:${convertToDecimal(order.tip).toFixed(2)} ${order.currency}`
          )
        );
      }

      if (order.deliveryInfo?.deliveryFee) {
        printer.newLine();
        printer.println(
          transliterate(
            `${translations.printOrder.deliveryFee[lang]}:${convertToDecimal(order.deliveryInfo.deliveryFee).toFixed(2)} ${order.currency}`
          )
        );
      }

      printer.newLine();
      printer.alignRight();
      printer.println(
        transliterate(
          `${translations.printOrder.total[lang]}:${convertToDecimal(order.total).toFixed(2)} ${order.currency}`
        )
      );
      printer.newLine();
      printer.println(
        transliterate(`${translations.printOrder.poweredBy[lang]}`)
      );
      printer.newLine();
      printer.newLine();
      printer.alignCenter();
      printer.println(
        transliterate(`${translations.printOrder.notReceiptNotice[lang]}`)
      );
      printer.cut();

      await printer.execute();
      logger.info(
        `Printed order ${order._id} to ${settings?.name || settings?.networkName}: ${settings?.ip || settings?.port}`
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
