/* eslint-disable no-plusplus */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-continue */
import {
  CharacterSet,
  printer as ThermalPrinter,
  types as PrinterTypes,
} from 'node-thermal-printer';
import { z } from 'zod';
import { Request, Response } from 'express';
import { Order } from '../resolvers/printOrders.ts';
import { convertToDecimal, leftPad, tr } from './common.ts';
import logger from './logger.ts';
import { IPrinterSettings, ISettings, PrinterTextSize } from './settings.ts';
import { SupportedLanguages, translations } from './translations.ts';

const DEFAULT_CODE_PAGE = 66;

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
      CharacterSet[settings.characterSet] || CharacterSet.PC869_GREEK,
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
  let device = `usb printer: ${port}`
  if (ip !== "") {
    interfaceString = `tcp://${ip}`;
    device = `ip printer: ${ip}`
  }

  console.log(interfaceString)
  const printer = new ThermalPrinter({
    characterSet: charset || CharacterSet.WPC1253_GREEK,
    interface: interfaceString,
    type: PrinterTypes.EPSON,
  });

  printer.clear();

  changeCodePage(printer, codePage || DEFAULT_CODE_PAGE);

  printer.alignCenter();
  printer.println(`charset: ${charset || CharacterSet.PC869_GREEK}`);
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
    await printer. execute();
    logger.info(`Printed test page to ${device}`);

    return 'success';
  } catch (error) {
    logger.error('Print failed:', error);
    throw new Error('print failed', {
      cause: error,
    });
  }
};

const PaymentMethod = Object.freeze({
  ACC_FOREIGN: { description: 'Επαγ. Λογαριασμός Πληρωμών Αλλοδαπής', value: '2' },
  ACC_NATIVE:  { description: 'Επαγ. Λογαριασμός Πληρωμών Ημεδαπής', value: '1' },
  CASH:        { description: 'ΜΕΤΡΗΤΑ', value: '3' },
  CHECK:       { description: 'ΕΠΙΤΑΓΗ', value: '4' },
  CREDIT:      { description: 'ΕΠΙ ΠΙΣΤΩΣΕΙ', value: '5' },
  IRIS:        { description: 'IRIS', value: '8' },
  POS:         { description: 'POS / e-POS', value: '7' },
  WEB_BANK:    { description: 'Web-banking', value: '6' },
});

const PaymentMethodDescriptions = Object.freeze(
  Object.fromEntries(
    Object.values(PaymentMethod).map(({ description, value }) => [value, description])
  )
);

export const paymentReceipt = (req: Request<{}, any, any>, res: Response<{}, any>) => {
  try {
    printPaymentReceipt(req.body.aadeInvoice,req.body.lang || 'el');
    res.status(200).send({ status: 'done' });
  } catch (error) {
    logger.error('Error printing test page:', error);
    res.status(400).send(error.message);
  }
};

const drawLine2 = (printer: ThermalPrinter) => {
  printer.println('------------------------------------------');
}

 const printPaymentReceipt = async (
  aadeInvoice: Object,
  lang: SupportedLanguages = 'el',
) => {
  for (let i = 0; i < printers.length; i += 1) {
    try {
      const settings = printers[i]?.[1];
      const printer = printers[i]?.[0];

      if (!settings || !printer) {
        continue;
      }
      
      printer.alignCenter();
      changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
      printer.bold(true);
      printer.println("**** ΦΟΡΟΛΟΓΙΚΗ ΑΠΟΔΕΙΞΗ ****");
      printer.println(aadeInvoice?.issuer.name)
      printer.bold(false);
      printer.println(aadeInvoice?.issuer.activity)
      printer.println(`${aadeInvoice?.issuer.address.street} ${aadeInvoice?.issuer.address.city}`)
      printer.println(`ΤΚ: ${aadeInvoice?.issuer.address.postal_code}`)
      printer.println(`ΑΦΜ: ${aadeInvoice?.issuer.vat_number} ΔΟΥ: ${aadeInvoice?.issuer.tax_office}`)
      printer.println(`ΤΗΛ: ${aadeInvoice?.issuer.phone}`)
      drawLine2(printer)
      printer.println(`ΗΜΕΡΟΜΗΝΙΑ: ${aadeInvoice?.issue_date}`);
      printer.println(`ΑΡ ΣΕΙΡΑΣ: ${aadeInvoice?.header.series.code} ${aadeInvoice?.header.serial_number}`);
      printer.println(`ΚΩΔΙΚΟΣ ΣΕΙΡΑΣ:${aadeInvoice?.header.code}`);
      let sumAmount = 0;
      let sumQuantity = 0;
      aadeInvoice?.details.forEach((detail: any) => {
        sumAmount+= detail.net_value * detail.quantity;
        sumQuantity+= detail.quantity;
        printer.newLine();
        drawLine2(printer)
        printer.newLine();
        printer.table([
          `     ${detail.name}`,
          `${detail.quantity}x ${detail.net_value}€`,
        ]);
      })
      printer.newLine();
      printer.println(`TEMAXIA: ${sumQuantity}`);
      drawLine2(printer)
      printer.alignRight();
      printer.println(`ΣΥΝΟΛΟ: ${sumAmount}€`);
      printer.alignCenter();
      drawLine2(printer)
      printer.println(`ΠΛΗΡΩΜΕΣ:`);
      aadeInvoice?.payment_methods.forEach((detail: any) => {
        printer.newLine();
        const methodDescription = PaymentMethodDescriptions[detail.code] || 'Άγνωστη Μέθοδος';
        printer.println(`${methodDescription}     ΠΟΣΟ: ${detail.amount}€`);
      })
      drawLine2(printer)
      printer.newLine();
      printer.println(`MARK: ${aadeInvoice?.mark}`);
      printer.println(`ΠΑΡΟΧΟΣ:`);
      printer.println(`${aadeInvoice?.url}`);
      printer.println(`ΑΝΑΓΝΩΡΙΣΤΙΚΟ:`);
      printer.println(`${aadeInvoice?.uid}`);
      printer.println(`ΥΠΟΓΡΑΦΗ:`);
      printer.println(`${aadeInvoice?.authentication_code}`);
      printer.newLine();
      printer.newLine();
      printer.printQR(aadeInvoice?.qr, {
        cellSize: 3,
        model: 3,
        correction: 'Q',
      });
      printer.println(
        tr(
          `${translations.printOrder.poweredBy[lang]}`,
          settings.transliterate
        )
      );
      printer.newLine();
      printer.bold(true);
      printer.println("**** ΦΟΡΟΛΟΓΙΚΗ ΑΠΟΔΕΙΞΗ - ΛΗΞΗ ****");
      printer.bold(false);
      printer.newLine();
      printer.alignCenter();
      printer.cut();
      printer
      .execute({
        waitForResponse: false,
      })
      .then(() => {
        logger.info(
         "Printed payment"
        );
      });
    } catch (error) {
      logger.error('Print failed:', error);
    }
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
          (category) => !settings?.categoriesToPrint?.includes(category)
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

      changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);

      for (let copies = 0; copies < settings.copies; copies += 1) {
        changeTextSize(printer, settings?.textSize || 'NORMAL');

        printer.drawLine();
        printer.newLine();
        printer.alignCenter();
        printer.println(
          tr(
            `${translations.printOrder.orderForm[lang]}`,
            settings.transliterate
          )
        );
        printer.alignLeft();
        printer.newLine();
        printer.println(tr(order.venue.title, settings.transliterate));
        printer.println(tr(order.venue.address, settings.transliterate));
        printer.drawLine();

        if (settings.textOptions.includes('BOLD_ORDER_NUMBER')) {
          printer.setTextSize(1, 1);
        }

        printer.table([
          `${date}`,
          `${time}`,
          tr(
            `${translations.printOrder.orderNumber[lang]}:#${order.number}`,
            settings.transliterate
          ),
        ]);

        if (order?.tableNumber) {
          printer.table([
            tr(
              `${translations.printOrder.tableNumber[lang]}:${order.tableNumber}`,
              settings.transliterate
            ),
            ...(order.waiterName
              ? [
                  tr(
                    `${translations.printOrder.waiter[lang]}:${order.waiterName}`,
                    settings.transliterate
                  ),
                ]
              : []),
          ]);
        }

        if (settings.textOptions.includes('BOLD_ORDER_TYPE')) {
          printer.setTextSize(1, 1);
        } else {
          changeTextSize(printer, settings?.textSize || 'NORMAL');
        }

        printer.println(
          tr(
            `${translations.printOrder.orderType[lang]}:${translations.printOrder.orderTypes[order.orderType][lang]}`,
            settings.transliterate
          )
        );
        printer.println(
          tr(
            `${translations.printOrder.paymentType[lang]}:${translations.printOrder.paymentTypes[order.paymentType][lang]}`,
            settings.transliterate
          )
        );

        changeTextSize(printer, settings?.textSize || 'NORMAL');

        printer.drawLine();

        if (order.deliveryInfo) {
          printer.println(
            tr(
              `${translations.printOrder.customerName[lang]}:${order.deliveryInfo.customerFirstname} ${order.deliveryInfo.customerLastname}`,
              settings.transliterate
            )
          );
          printer.println(
            tr(
              `${translations.printOrder.deliveryAddress[lang]}:${order.deliveryInfo.customerAddress}`,
              settings.transliterate
            )
          );
          printer.println(
            tr(
              `${translations.printOrder.deliveryFloor[lang]}:${order.deliveryInfo.customerFloor}`,
              settings.transliterate
            )
          );
          printer.println(
            tr(
              `${translations.printOrder.deliveryBell[lang]}:${order.deliveryInfo.customerBell}`,
              settings.transliterate
            )
          );
          printer.println(
            tr(
              `${translations.printOrder.deliveryPhone[lang]}:${order.deliveryInfo.customerPhoneNumber}`,
              settings.transliterate
            )
          );
          printer.drawLine();
        }

        if (order.TakeAwayInfo) {
          let drawLine = false;

          const customerName = order.TakeAwayInfo.customerName?.trim();

          if (
            (customerName && customerName !== 'null') ||
            customerName !== 'undefined'
          ) {
            printer.println(
              tr(
                `${translations.printOrder.customerName[lang]}:${order.TakeAwayInfo.customerName}`,
                settings.transliterate
              )
            );
            drawLine = true;
          }

          if (order.TakeAwayInfo.customerEmail) {
            printer.println(
              tr(
                `${translations.printOrder.customerEmail[lang]}:${order.TakeAwayInfo.customerEmail}`,
                settings.transliterate
              )
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
            tr(
              `${product.quantity}x ${product.title}  ${
                product.total
                  ? `${convertToDecimal(product.total).toFixed(2)}€`
                  : ''
              }
            `,
              settings.transliterate
            )
          );

          product.choices?.forEach((choice) => {
            total += (choice.price || 0) * (choice.quantity || 1);
            printer.println(
              tr(
                `${leftPad(
                  ` - ${Number(choice.quantity) > 1 ? `${choice.quantity}x` : ''} ${choice.title}`,
                  leftAmount,
                  ' '
                )}  ${
                  choice.price
                    ? `+${convertToDecimal(choice.price * (choice.quantity || 1)).toFixed(2)} €`
                    : ''
                }`,
                settings.transliterate
              )
            );
          });
          if (product.comments){
          printer.println(
            tr(
              ` ${translations.printOrder.productComments[lang]}:${product.comments.toUpperCase()}`,
              settings.transliterate
            )
          );
        }

          printer.alignRight();
          printer.println(
            tr(
              `${convertToDecimal(total).toFixed(2)} €`,
              settings.transliterate
            )
          );
          printer.alignLeft();
          printer.drawLine();
        });

        if (order.waiterComment) {
          printer.newLine();
          printer.println(
            tr(
              `${translations.printOrder.waiterComments[lang]}:${order.waiterComment.toUpperCase()}`,
              settings.transliterate
            )
          );
        }

        if (order.customerComment) {
          printer.newLine();
          printer.println(
            tr(
              `${translations.printOrder.customerComments[lang]}:${order.customerComment}`,
              settings.transliterate
            )
          );
        }


        changeTextSize(printer, settings?.textSize || 'NORMAL');

        if (order.tip) {
          printer.newLine();
          printer.println(
            tr(
              `${translations.printOrder.tip[lang]}:${convertToDecimal(order.tip).toFixed(2)} €`,
              settings.transliterate
            )
          );
        }

        if (order.deliveryInfo?.deliveryFee) {
          printer.newLine();
          printer.println(
            tr(
              `${translations.printOrder.deliveryFee[lang]}:${convertToDecimal(order.deliveryInfo.deliveryFee).toFixed(2)} €`,
              settings.transliterate
            )
          );
        }

        printer.newLine();
        printer.alignRight();
        printer.println(
          tr(
            `${translations.printOrder.total[lang]}:${convertToDecimal(order.total).toFixed(2)} €`,
            settings.transliterate
          )
        );
        printer.newLine();
        printer.println(
          tr(
            `${translations.printOrder.poweredBy[lang]}`,
            settings.transliterate
          )
        );
        printer.newLine();
        printer.newLine();
        printer.alignCenter();
        printer.println(
          tr(
            `${translations.printOrder.notReceiptNotice[lang]}`,
            settings.transliterate
          )
        );
        printer.cut();
      }

      printer
        .execute({
          waitForResponse: false,
        })
        .then(() => {
          logger.info(
            `Printed order ${order._id} to ${settings?.name || settings?.networkName || ''}: ${settings?.ip || settings?.port}`
          );
        });
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
