/* eslint-disable no-await-in-loop */
/* eslint-disable no-continue */
import {
  CharacterSet,
  printer as ThermalPrinter,
  types as PrinterTypes,
} from 'node-thermal-printer';
import { z } from 'zod';

import { Order } from '../resolvers/printOrders.ts';
import { convertToDecimal, leftPad } from './common.ts';
import logger from './logger.ts';
import { IPrinterSettings, ISettings, PrinterTextSize } from './settings.ts';
import { SupportedLanguages, translations } from './translations.ts';

const CODE_PAGE_WPC1253 = 17;

const printers: [ThermalPrinter, IPrinterSettings][] = [];

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

const changeCodePage = (printer: ThermalPrinter, codePage: number) => {
  printer.add(Buffer.from([0x1b, 0x74, codePage]));
};

export const setupPrinters = async (settings: ISettings) => {
  printers.length = 0;

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
      `Setting up printer ${printerSettings.name || printerSettings.ip} with config:`,
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
      CharacterSet[settings.characterSet] || CharacterSet.WPC1253_GREEK,
    interface: interfaceString || '',
    type: PrinterTypes.EPSON,
  };

  logger.info(`Setting up printer ${settings.name} with \n
  config: ${JSON.stringify(config, null, 2)}\n
  settings: ${JSON.stringify(settings, null, 2)}\n`);

  return new ThermalPrinter(config);
};

export const printTestPage = async (
  ip: string,
  port: string,
  charset?: CharacterSet,
  codePage?: number
): Promise<string> => {
  let interfaceString = port;

  if (ip) {
    interfaceString = `tcp://${ip}`;
  }

  const printer = new ThermalPrinter({
    characterSet: charset || CharacterSet.WPC1253_GREEK,
    interface: interfaceString,
    type: PrinterTypes.EPSON,
  });

  printer.clear();

  changeCodePage(printer, codePage || CODE_PAGE_WPC1253);

  printer.alignCenter();
  printer.println(`charset: ${charset || CharacterSet.WPC1253_GREEK}`);
  printer.println(`ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω`);
  printer.newLine();
  printer.println('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
  printer.newLine();
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
    try {
      const settings = printers[i]?.[1];
      const printer = printers[i]?.[0];

      if (!settings || !printer) {
        continue;
      }

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

      changeCodePage(printer, settings?.codePage || CODE_PAGE_WPC1253);

      for (let copies = 0; copies < settings.copies; copies += 1) {
        changeTextSize(printer, settings?.textSize || 'NORMAL');

        printer.drawLine();
        printer.newLine();
        printer.alignCenter();
        printer.println(`${translations.printOrder.orderForm[lang]}`);
        printer.alignLeft();
        printer.newLine();
        printer.println(order.venue.title);
        printer.println(order.venue.address);
        printer.drawLine();

        if (settings.textOptions.includes('BOLD_ORDER_NUMBER')) {
          printer.setTextSize(1, 1);
        }

        printer.table([
          `${date}`,
          `${time}`,
          `${translations.printOrder.orderNumber[lang]}:#${order.number}`,
        ]);

        if (order?.tableNumber) {
          printer.table([
            `${translations.printOrder.tableNumber[lang]}:${order.tableNumber}`,
            ...(order.waiterName
              ? [`${translations.printOrder.waiter[lang]}:${order.waiterName}`]
              : []),
          ]);
        }

        changeTextSize(printer, settings?.textSize || 'NORMAL');

        printer.println(
          `${translations.printOrder.orderType[lang]}:${translations.printOrder.orderTypes[order.orderType][lang]}`
        );
        printer.println(
          `${translations.printOrder.paymentType[lang]}:${translations.printOrder.paymentTypes[order.paymentType][lang]}`
        );
        printer.drawLine();

        if (order.deliveryInfo) {
          printer.println(
            `${translations.printOrder.customerName[lang]}:${order.deliveryInfo.customerFirstname} ${order.deliveryInfo.customerLastname}`
          );
          printer.println(
            `${translations.printOrder.deliveryAddress[lang]}:${order.deliveryInfo.customerAddress}`
          );
          printer.println(
            `${translations.printOrder.deliveryFloor[lang]}:${order.deliveryInfo.customerFloor}`
          );
          printer.println(
            `${translations.printOrder.deliveryBell[lang]}:${order.deliveryInfo.customerBell}`
          );
          printer.println(
            `${translations.printOrder.deliveryPhone[lang]}:${order.deliveryInfo.customerPhoneNumber}`
          );
          printer.drawLine();
        }

        if (order.TakeAwayInfo) {
          let drawLine = false;

          if (order.TakeAwayInfo.customerName) {
            printer.println(
              `${translations.printOrder.customerName[lang]}:${order.TakeAwayInfo.customerName}`
            );
            drawLine = true;
          }

          if (order.TakeAwayInfo.customerEmail) {
            printer.println(
              `${translations.printOrder.customerEmail[lang]}:${order.TakeAwayInfo.customerEmail}`
            );
            drawLine = true;
          }

          if (drawLine) {
            printer.drawLine();
          }
        }

        if (settings?.textOptions) {
          settings.textOptions?.forEach((textOption) => {
            switch (textOption) {
              case 'BOLD_PRODUCTS':
                printer.setTextSize(1, 1);
                break;
              default:
                break;
            }
          });
        }

        productsToPrint.forEach((product) => {
          let total = product.total;

          printer.newLine();
          const leftAmount = `${product.quantity}x `.length;
          printer.println(
            `${product.quantity}x ${product.title}  ${
              product.total
                ? `${convertToDecimal(product.total).toFixed(2)} €`
                : ''
            }`
          );
          product.choices?.forEach((choice) => {
            total += (choice.price || 0) * (choice.quantity || 1);
            printer.println(
              `${leftPad(
                ` - ${Number(choice.quantity) > 1 ? `${choice.quantity}x` : ''} ${choice.title}`,
                leftAmount,
                ' '
              )}  ${
                choice.price
                  ? `+${convertToDecimal(choice.price * (choice.quantity || 1)).toFixed(2)} €`
                  : ''
              }`
            );
          });

          printer.alignRight();
          printer.println(`${convertToDecimal(total).toFixed(2)} €`);
          printer.alignLeft();
        });

        if (order.waiterComment) {
          printer.newLine();
          printer.println(
            `${translations.printOrder.waiterComments[lang]}:${order.waiterComment}`
          );
        }

        if (order.customerComment) {
          printer.newLine();
          printer.println(
            `${translations.printOrder.customerComments[lang]}:${order.customerComment}`
          );
        }

        printer.drawLine();

        changeTextSize(printer, settings?.textSize || 'NORMAL');

        if (order.tip) {
          printer.newLine();
          printer.println(
            `${translations.printOrder.tip[lang]}:${convertToDecimal(order.tip).toFixed(2)} €`
          );
        }

        if (order.deliveryInfo?.deliveryFee) {
          printer.newLine();
          printer.println(
            `${translations.printOrder.deliveryFee[lang]}:${convertToDecimal(order.deliveryInfo.deliveryFee).toFixed(2)} €`
          );
        }

        printer.newLine();
        printer.alignRight();
        printer.println(
          `${translations.printOrder.total[lang]}:${convertToDecimal(order.total).toFixed(2)} €`
        );
        printer.newLine();
        printer.println(`${translations.printOrder.poweredBy[lang]}`);
        printer.newLine();
        printer.newLine();
        printer.alignCenter();
        printer.println(`${translations.printOrder.notReceiptNotice[lang]}`);
        printer.cut();
      }

      await printer.execute({
        waitForResponse: false,
      });

      logger.info(
        `Printed order ${order._id} to ${settings?.name || settings?.networkName || ''}: ${settings?.ip || settings?.port}`
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
