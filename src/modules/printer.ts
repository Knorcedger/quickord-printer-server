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
import { Order } from '../resolvers/printOrders';
import { convertToDecimal, leftPad, tr } from './common';
import logger from './logger';
import { IPrinterSettings, ISettings, PrinterTextSize } from './settings';
import { SupportedLanguages, translations } from './translations';
import { connect } from 'node:http2';
import { connected } from 'node:process';
const { exec } = require('child_process');
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
function isUsbPrinterOnline(shareName: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const command = `powershell -NoProfile -Command "Get-WmiObject -Query \\"SELECT * FROM Win32_Printer WHERE ShareName = '${shareName}'\\" | Select-Object -ExpandProperty WorkOffline"`;

    exec(command, (error, stdout, stderr) => {
      if (error || stderr) {
        return reject(error || stderr);
      }

      const output = stdout.trim().toLowerCase();
      const isOffline = output === 'true';
      resolve(!isOffline); // true if online
    });
  });
}

// Example usage

export const printTestPage = async (
  ip: string,
  port: string,
  charset?: CharacterSet,
  codePage?: number
): Promise<string> => {
  let interfaceString = port;
  let device = `usb printer: ${port}`;
  if (ip !== '') {
    interfaceString = `tcp://${ip}`;
    device = `ip printer: ${ip}`;
  }
 
  console.log(interfaceString);
  const printer = new ThermalPrinter({
    characterSet: charset || CharacterSet.WPC1253_GREEK,
    interface: interfaceString,
    type: PrinterTypes.EPSON,
  });
 

console.log(printers);
 let connected = false;
 if (ip !== '') {
    connected =  await printer?.isPrinterConnected();
} else {
 try {
  const shareName = interfaceString.split("\\").pop() || '';
  connected = await isUsbPrinterOnline(shareName); // port = 'printerServer'
  } catch (error) {
    console.error('Error checking printer connection:', error);
    connected = false;
  }
}
  if (!connected) {
        console.log('Printer not connected');
        printer?.clear();
       return 'Printer not connected'
      }
  printer.clear();

  changeCodePage(printer, codePage || DEFAULT_CODE_PAGE);

  printer.alignCenter();
  printer.println(`charset: ${charset || CharacterSet.PC869_GREEK}`);
  printer.println(`ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω`);
  printer.newLine();
  printer.println('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
  printer.newLine();
  /*   const processedImage = await sharp("euro.png")
      .resize(384) // resize width to fit printer
      .threshold(128) // convert to black and white
      .toBuffer();*/
  //printer.printImageBuffer(processedImage)
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
  ACC_FOREIGN: {
    description: 'Επαγ. Λογαριασμός Πληρωμών Αλλοδαπής',
    value: '2',
  },
  ACC_NATIVE: {
    description: 'Επαγ. Λογαριασμός Πληρωμών Ημεδαπής',
    value: '1',
  },
  CASH: { description: 'ΜΕΤΡΗΤΑ', value: '3' },
  CHECK: { description: 'ΕΠΙΤΑΓΗ', value: '4' },
  CREDIT: { description: 'ΕΠΙ ΠΙΣΤΩΣΕΙ', value: '5' },
  IRIS: { description: 'IRIS', value: '8' },
  POS: { description: 'POS / e-POS', value: '7' },
  WEB_BANK: { description: 'Web-banking', value: '6' },
});

const PaymentMethodDescriptions = Object.freeze(
  Object.fromEntries(
    Object.values(PaymentMethod).map(({ description, value }) => [
      value,
      description,
    ])
  )
);
export const paymentSlip = (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    printPaymentSlip(
      req.body.aadeInvoice,
      req.body.issuerText,
      req.body.orderNumber,
      req.body.lang || 'el'
    );
    res.status(200).send({ status: 'done' });
  } catch (error) {
    logger.error('Error printing test page:', error);
    res.status(400).send(error.message);
  }
};
export const paymentReceipt = (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    printPaymentReceipt(
      req.body.aadeInvoice,
      req.body.orderNumber,
      req.body.orderType,
      req.body.issuerText,
      req.body.lang || 'el'
    );
    res.status(200).send({ status: 'done' });
  } catch (error) {
    logger.error('Error printing test page:', error);
    res.status(400).send(error.message);
  }
};
export const orderForm = (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    printOrderForm(
      req.body.aadeInvoice,
      req.body.table,
      req.body.waiter,
      req.body.lang || 'el'
    );
    res.status(200).send({ status: 'done' });
  } catch (error) {
    logger.error('Error printing test page:', error);
    res.status(400).send(error.message);
  }
};

const drawLine2 = (printer: ThermalPrinter) => {
  printer.println('------------------------------------------');
};

interface AadeInvoice {
  issuer: {
    name: string;
    activity: string;
    address: {
      street: string;
      city: string;
      postal_code: string;
    };
    vat_number: string;
    tax_office: string;
    phone: string;
  };
  issue_date: string;
  header: {
    series: {
      code: string;
    };
    serial_number: string;
    code: string;
  };
  details: {
    name: string;
    quantity: number;
    net_value: number;
  }[];
  payment_methods: {
    code: string;
    amount: number;
  }[];
  mark: string;
  url: string;
  uid: string;
  authentication_code: string;
  qr: string;
}

const printOrderForm = async (
  aadeInvoice: AadeInvoice,
  tableNumber: string,
  waiterName: string,
  lang: SupportedLanguages = 'el'
) => {
  for (let i = 0; i < printers.length; i += 1) {
    try {
      const settings = printers[i]?.[1];
      const printer = printers[i]?.[0];
      printer?.clear();
      if (!settings || !printer) {
        continue;
      }
      if (settings.documentsToPrint !== undefined) {
        if (!settings.documentsToPrint?.includes('ORDERFORM')) {
          console.log('ORDERFORM is not in documentsToPrint');
          continue;
        }
      }
      console.log(aadeInvoice);
      printer.alignCenter();
      changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
      printer.println(aadeInvoice?.issuer.name);
      printer.println(aadeInvoice?.issuer.activity);
      printer.println(
        `${aadeInvoice?.issuer.address.street} ${aadeInvoice?.issuer.address.city}, ${aadeInvoice?.issuer.address.postal_code}`
      );

      printer.println(
        `${translations.printOrder.taxNumber[lang]}: ${aadeInvoice?.issuer.vat_number} - ${translations.printOrder.taxOffice[lang]}: ${aadeInvoice?.issuer.tax_office}`
      );
      printer.println(
        `${translations.printOrder.deliveryPhone[lang]}: ${aadeInvoice?.issuer.phone}`
      );
      printer.newLine();
      printer.alignLeft();
      const rawDate = aadeInvoice?.issue_date; // e.g., "2025-04-23"
      const day = rawDate.substring(8, 10);
      const month = rawDate.substring(5, 7).replace(/^0/, ''); // remove leading zero
      const year = rawDate.substring(0, 4);
      const formattedDate = `${day}/${month}/${year}`;
      printer.println(
        `${translations.printOrder.date[lang]} : ${formattedDate}`.padEnd(24) +
          `${translations.printOrder.time[lang]} : ${aadeInvoice?.issue_date.substring(11, 16)}`
      );

      // Second line: table and server
      printer.println(
        `${translations.printOrder.tableNumber[lang]} : ${tableNumber}`.padEnd(
          24
        ) +
          `${translations.printOrder.waiter[lang]} : ${waiterName.toUpperCase()}`
      );
      printer.newLine();
      printer.alignCenter();
      printer.println(
        tr(`${translations.printOrder.orderForm[lang]}`, settings.transliterate)
      );
      printer.println(
        `${translations.printOrder.seriesNumber[lang]}: ${aadeInvoice?.header.series.code} ${aadeInvoice?.header.serial_number}`
      );
      printer.newLine();
      printer.alignLeft();
      printer.println(
        `${translations.printOrder.kind[lang]}`.padEnd(18) +
          `${translations.printOrder.quantity[lang]}`.padEnd(7) +
          `${translations.printOrder.price[lang]}`.padEnd(7) +
          `${translations.printOrder.vat[lang]}`
      );
      drawLine2(printer);
      let sumAmount = 0;
      let sumQuantity = 0;

      aadeInvoice?.details.forEach((detail: any) => {
        sumAmount += detail.net_value * detail.quantity;
        sumQuantity += detail.quantity;

        const name = detail.name;
        const quantity = detail.quantity.toFixed(3).replace('.', ','); // "1,000"
        const value = (detail.net_value * (1 + detail.tax.rate / 100)).toFixed(
          2
        );
        const vat = `${detail.tax.rate}%`; // "24%"

        printer.println(
          name.padEnd(18).substring(0, 18) + // Trim to 18 chars max
            quantity.padEnd(7) +
            value.padEnd(7) +
            vat
        );
      });
      drawLine2(printer);
      printer.alignRight();
      printer.newLine();
      printer.alignLeft();
      printer.println(`MARK ${aadeInvoice?.mark}`);
      printer.println(`UID ${aadeInvoice?.uid}`);
      printer.println(`AUTH ${aadeInvoice?.authentication_code}`);
      printer.alignCenter();
      printer.printQR(aadeInvoice?.url, {
        cellSize: 4,
        model: 4,
        correction: 'Q',
      });
      printer.newLine();
      printer.println(
        `${translations.printOrder.provider[lang]} www.invoiceportal.gr`
      );
      printer.newLine();
      printer.println(
        tr(`${translations.printOrder.poweredBy[lang]}`, settings.transliterate)
      );
      printer.newLine();
      printer.alignCenter();
      printer.cut();
      printer
        .execute({
          waitForResponse: false,
        })
        .then(() => {
          printer?.clear();
          logger.info('Printed payment');
        });
    } catch (error) {
      logger.error('Print failed:', error);
    }
  }
};
const printPaymentSlip = async (
  aadeInvoice: AadeInvoice,
  issuerText: string,
  orderNumber: number,
  lang: SupportedLanguages = 'el'
) => {
  for (let i = 0; i < printers.length; i += 1) {
    try {
      const settings = printers[i]?.[1];
      const printer = printers[i]?.[0];
      printer?.clear();
      if (!settings || !printer) {
        continue;
      }
      if (settings.documentsToPrint !== undefined) {
        if (!settings.documentsToPrint?.includes('PAYMENT-SLIP')) {
          console.log('PAYMENT-SLIP is not in documentsToPrint');
          continue;
        }
      }
      printer.alignCenter();
      changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
      printer.println(`${translations.printOrder.paymentSlip[lang]}`);
      printer.println(aadeInvoice?.issuer.name);
      printer.println(aadeInvoice?.issuer.activity);
      printer.println(
        `${aadeInvoice?.issuer.address.street} ${aadeInvoice?.issuer.address.city}, ${aadeInvoice?.issuer.address.postal_code}`
      );

      printer.println(
        `${translations.printOrder.taxNumber[lang]}: ${aadeInvoice?.issuer.vat_number} - ${translations.printOrder.taxOffice[lang]}: ${aadeInvoice?.issuer.tax_office}`
      );
      printer.println(
        `${translations.printOrder.deliveryPhone[lang]}: ${aadeInvoice?.issuer.phone}`
      );
      if (issuerText) {
        printer.println(issuerText);
      }
      printer.newLine();
      printer.alignLeft();
      const rawDate = aadeInvoice?.issue_date; // e.g., "2025-04-23"
      const day = rawDate.substring(8, 10);
      const month = rawDate.substring(5, 7).replace(/^0/, ''); // remove leading zero
      const year = rawDate.substring(0, 4);
      const formattedDate = `${day}/${month}/${year}`;
      printer.newLine();
      printer.println(`#${orderNumber}`);
      printer.println(
        `${formattedDate},${aadeInvoice?.issue_date.substring(11, 16)}`
      );
      printer.alignLeft();

      printer.newLine();
      printer.println(
        `${aadeInvoice?.header.series.code}${aadeInvoice?.header.serial_number}`
      );
      printer.newLine();
      printer.alignLeft();

      let sumAmount = 0;
      let sumQuantity = 0;

      aadeInvoice?.details.forEach((detail: any) => {
        printer.bold(true);
        sumQuantity += detail.quantity;

        const name = detail.name;
        const quantity = detail.quantity.toFixed(3).replace('.', ','); // "1,000"
        const value = (detail.net_value * (1 + detail.tax.rate / 100)).toFixed(
          2
        );
        const vat = `${detail.tax.rate}%`; // "24%"
        sumAmount += parseFloat(value);
        printer.println(
          name.toUpperCase().padEnd(18).substring(0, 18) + // Trim to 18 chars max
            quantity.padStart(7) +
            value.padStart(7) +
            vat.padStart(7)
        );
        printer.bold(false);
      });
      drawLine2(printer);
      printer.newLine();
      printer.alignRight();
      const roundedSum = Number(sumAmount)
        .toFixed(2)
        .replace(/\.?0+$/, '');
      printer.println(`${translations.printOrder.sum[lang]}: ${roundedSum}€`);
      printer.bold(false);
      printer.alignCenter();
      drawLine2(printer);
      printer.println(`${translations.printOrder.payments[lang]}:`);
      aadeInvoice?.payment_methods.forEach((detail: any) => {
        printer.newLine();
        const methodDescription =
          PaymentMethod[detail.code].description ||
          translations.printOrder.unknown[lang];
        printer.println(
          `${methodDescription}     ${translations.printOrder.amount[lang]}: ${detail.amount.toFixed(2)}€`
        );
      });
      drawLine2(printer);
      printer.newLine();
      printer.alignLeft();
      printer.println(`MARK ${aadeInvoice?.mark}`);
      printer.println(`UID ${aadeInvoice?.uid}`);
      printer.println(`AUTH ${aadeInvoice?.authentication_code}`);
      printer.alignCenter();
      printer.printQR(aadeInvoice?.url, {
        cellSize: 4,
        model: 4,
        correction: 'Q',
      });
      printer.newLine();
      printer.println(
        `${translations.printOrder.provider[lang]} www.invoiceportal.gr`
      );
      printer.newLine();
      printer.println(
        tr(`${translations.printOrder.poweredBy[lang]}`, settings.transliterate)
      );
      printer.newLine();
      printer.println(
        tr(
          `${translations.printOrder.paymentSlipEnd[lang]}`,
          settings.transliterate
        )
      );
      printer.alignCenter();
      printer.cut();
      printer
        .execute({
          waitForResponse: false,
        })
        .then(() => {
          printer?.clear();
          logger.info('Printed payment');
        });
    } catch (error) {
      logger.error('Print failed:', error);
    }
  }
};

type ServiceType = {
  value: string;
  label_en: string;
  label_el: string;
};

const SERVICES: Record<string, ServiceType> = {
  wolt: {
    value: 'wolt',
    label_en: 'Wolt',
    label_el: 'Wolt',
  },
  efood: {
    value: 'efood',
    label_en: 'eFood',
    label_el: 'eFood',
  },
  box: {
    value: 'box',
    label_en: 'BOX',
    label_el: 'BOX',
  },
  fagi: {
    value: 'fagi',
    label_en: 'Fagi',
    label_el: 'Fagi',
  },
  store: {
    value: 'store',
    label_en: 'Store',
    label_el: 'Κατάστημα',
  },
  phone: {
    value: 'phone',
    label_en: 'Phone',
    label_el: 'Τηλέφωνο',
  },
  website: {
    value: 'website',
    label_en: 'Website',
    label_el: 'Ιστότοπος',
  },
};

const printPaymentReceipt = async (
  aadeInvoice: AadeInvoice,
  orderNumber: number,
  orderType: string,
  issuerText: string,
  lang: SupportedLanguages = 'el'
) => {
  for (let i = 0; i < printers.length; i += 1) {
    const settings = printers[i]?.[1];
    const printer = printers[i]?.[0];
    printer?.clear();
    if (!settings || !printer) {
      continue;
    }
    if (settings.documentsToPrint !== undefined) {
      if (!settings.documentsToPrint?.includes('ALP')) {
        console.log('ALP is not in documentsToPrint');
        continue;
      }
    }
    for (let copies = 0; copies < settings.copies; copies += 1) {
      console.log('print copies: ', copies);
      try {
        changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
        printer.alignCenter();
        printer.println(`${translations.printOrder.reciept[lang]}`);
        printer.println(aadeInvoice?.issuer.name);
        printer.println(aadeInvoice?.issuer.activity);
        printer.println(
          `${aadeInvoice?.issuer.address.street} ${aadeInvoice?.issuer.address.city}, ${aadeInvoice?.issuer.address.postal_code}`
        );

        printer.println(
          `${translations.printOrder.taxNumber[lang]}: ${aadeInvoice?.issuer.vat_number} - ${translations.printOrder.taxOffice[lang]}: ${aadeInvoice?.issuer.tax_office}`
        );
        printer.println(
          `${translations.printOrder.deliveryPhone[lang]}: ${aadeInvoice?.issuer.phone}`
        );
        if (issuerText) {
          printer.println(issuerText);
        }
        printer.alignLeft();
        const rawDate = aadeInvoice?.issue_date; // e.g., "2025-04-23"
        const day = rawDate.substring(8, 10);
        const month = rawDate.substring(5, 7).replace(/^0/, ''); // remove leading zero
        const year = rawDate.substring(0, 4);
        const formattedDate = `${day}/${month}/${year}`;
        printer.newLine();
        printer.println(`#${orderNumber}`);
        printer.println(
          `${formattedDate},${aadeInvoice?.issue_date.substring(11, 16)}`
        );
        printer.alignLeft();
        if (lang === 'el') {
          printer.println(
            `${aadeInvoice?.header.series.code}${aadeInvoice?.header.serial_number}, ${SERVICES[orderType.toLowerCase()]?.label_el}`
          );
        } else {
          printer.println(
            `${aadeInvoice?.header.series.code}${aadeInvoice?.header.serial_number}, ${SERVICES[orderType.toLowerCase()]?.label_en}`
          );
        }
        printer.newLine();
        printer.alignLeft();
        printer.println(
          `${translations.printOrder.kind[lang]}`.padEnd(18) +
            `${translations.printOrder.quantity[lang]}`.padEnd(7) +
            `${translations.printOrder.price[lang]}`.padEnd(7) +
            `${translations.printOrder.vat[lang]}`
        );
        drawLine2(printer);
        let sumAmount = 0;
        let sumQuantity = 0;

        aadeInvoice?.details.forEach((detail: any) => {
          sumQuantity += detail.quantity;

          const name = detail.name;
          const quantity = detail.quantity.toFixed(3).replace('.', ','); // "1,000"
          const value = (
            detail.net_value *
            (1 + detail.tax.rate / 100)
          ).toFixed(2);
          const vat = `${detail.tax.rate}%`; // "24%"
          sumAmount += parseFloat(value);
          printer.println(
            name.padEnd(18).substring(0, 18) + // Trim to 18 chars max
              quantity.padEnd(7) +
              value.padEnd(7) +
              vat
          );
        });
        drawLine2(printer);
        // Line 1: Left-aligned item quantity (small text)
        printer.setTextSize(0, 0);
        printer.bold(true);
        printer.alignLeft();

        const lineWidth = 42; // Adjust based on your printer (usually 32 or 42 characters at size 0,0)
        const leftText = `${translations.printOrder.items[lang]}: ${sumQuantity}`;
        const roundedSum = Number(sumAmount)
          .toFixed(2)
          .replace(/\.?0+$/, '');
        const rightText = `${translations.printOrder.sum[lang]}: ${roundedSum}€`;

        // Calculate spacing
        const spaceCount = lineWidth - leftText.length - rightText.length;
        const spacing = ' '.repeat(Math.max(1, spaceCount));

        // Print both on one line
        printer.println(leftText + spacing + rightText);

        printer.bold(false);
        printer.alignCenter();
        drawLine2(printer);
        printer.println(`${translations.printOrder.payments[lang]}:`);
        aadeInvoice?.payment_methods.forEach((detail: any) => {
          console.log(detail.code);
          printer.newLine();
          const methodDescription =
            PaymentMethod[detail.code].description ||
            translations.printOrder.unknown[lang];
          printer.println(
            `${methodDescription}     ${translations.printOrder.amount[lang]}: ${detail.amount.toFixed(2)}€`
          );
        });
        drawLine2(printer);
        printer.newLine();
        printer.alignLeft();
        printer.println(`MARK ${aadeInvoice?.mark}`);
        printer.println(`UID ${aadeInvoice?.uid}`);
        printer.println(`AUTH ${aadeInvoice?.authentication_code}`);
        printer.alignCenter();
        printer.printQR(aadeInvoice?.url, {
          cellSize: 4,
          model: 4,
          correction: 'Q',
        });
        printer.newLine();
        printer.println(
          `${translations.printOrder.provider[lang]} www.invoiceportal.gr`
        );
        printer.newLine();
        printer.println(
          tr(
            `${translations.printOrder.poweredBy[lang]}`,
            settings.transliterate
          )
        );
        printer.newLine();
        printer.println(
          tr(
            `${translations.printOrder.recieptEnd[lang]}`,
            settings.transliterate
          )
        );
        printer.alignCenter();
        printer.cut();
        printer
          .execute({
            waitForResponse: false,
          })
          .then(() => {
            printer?.clear();
            logger.info('Printed payment');
          });
      } catch (error) {
        logger.error('Print failed:', error);
      }
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
      printer?.clear();
      if (!settings || !printer) {
        printer?.clear();
        continue;
      }
      if (settings.orderMethodsToPrint !== undefined) {
        if (!settings.orderMethodsToPrint?.includes(order.orderType)) {
          console.log('orderType is not in orderMethodsToPrint');
          continue;
        }
      }
      const productsToPrint = order.products.filter((product) =>
        product.categories.some((category) =>
          settings?.categoriesToPrint?.includes(category)
        )
      );
      console.log(productsToPrint)
      if (!productsToPrint?.length) {
        printer?.clear();
        continue;
      }
      if (settings.documentsToPrint !== undefined) {
        if (!settings.documentsToPrint?.includes('ORDER')) {
          console.log('ORDER is not in documentsToPrint');
          continue;
        }
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

      for (let copies = 0; copies < settings.copies; copies += 1) {
        changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
        changeTextSize(printer, settings?.textSize || 'NORMAL');
        printer.newLine();
        printer.alignCenter();
        printer.println(
          tr(
            `${translations.printOrder.orderFormOrder[lang]}`,
            settings.transliterate
          )
        );
        printer.alignLeft();
        printer.newLine();
        printer.println(tr(order.venue.title, settings.transliterate));
        printer.println(tr(order.venue.address, settings.transliterate));
        drawLine2(printer);

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
        if (order?.orderType === 'DINE_IN') {
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

        drawLine2(printer);

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
          drawLine2(printer);
        }

        if (order.TakeAwayInfo && order.orderType !== 'TAKE_AWAY_INSIDE') {
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
            drawLine2(printer);
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
        const vatBreakdown: { vat: number; total: number; netValue: number }[] =
          [];
        productsToPrint.forEach((product) => {
          let total = product.total || 0;
          const leftAmount = `${product.quantity}x `.length;

          // Bold if enabled
          if (settings.textOptions.includes('BOLD_PRODUCTS')) {
            printer.setTextSize(1, 1);
          } else {
            changeTextSize(printer, settings?.textSize || 'NORMAL');
          }

          // Pad title and amount for alignment
          const productLine = `${product.quantity}x ${product.title}`;
          const priceStr = product.total
            ? `${convertToDecimal(product.total).toFixed(2)} €`
            : '';
          const lineWidth = 42; // Assuming 42 character width for POS80
          const paddedLine =
            productLine.padEnd(lineWidth - priceStr.length, ' ') + priceStr;

          printer.println(tr(paddedLine, settings.transliterate));

          // Handle product choices
          product.choices?.forEach((choice) => {
            total += (choice.price || 0) * (product.quantity || 1);
            const choiceLine = `- ${Number(choice.quantity) > 1 ? `${product.quantity}x ` : ''}${choice.title}`;
            const choicePrice = choice.price
              ? `+${convertToDecimal(choice.price * (product.quantity || 1)).toFixed(2)} €`
              : '';
            const paddedChoiceLine =
              choiceLine.padEnd(lineWidth - choicePrice.length, ' ') +
              choicePrice;
            printer.println(tr(paddedChoiceLine, settings.transliterate));
          });

          // Comments (if any)
          if (product.comments) {
            printer.println(
              tr(
                ` ${translations.printOrder.productComments[lang]}: ${product.comments.toUpperCase()}`,
                settings.transliterate
              )
            );
          }

          // VAT info (if any)
          if (product.vat) {
            printer.println(
              tr(
                `${translations.printOrder.vat[lang]}: ${product.vat}%`,
                settings.transliterate
              )
            );

            const vatRate = product.vat;

            let choicesTotal = 0;
            if (product.choices) {
              product.choices.forEach((choice) => {
                choicesTotal += (choice.price || 0) * (product.quantity || 1);
              });
            }

            const rawTotal = product.total * product.quantity + choicesTotal;
            const rawNet = rawTotal / (1 + vatRate / 100);

            const fullTotal = parseFloat(convertToDecimal(rawTotal).toFixed(2));
            const netValue = parseFloat(convertToDecimal(rawNet).toFixed(2));

            const existingVat = vatBreakdown.find(
              (item) => item.vat === vatRate
            );
            if (existingVat) {
              existingVat.total += fullTotal;
              existingVat.netValue += netValue;
            } else {
              vatBreakdown.push({
                vat: vatRate,
                total: fullTotal,
                netValue: netValue,
              });
            }
          }

          // Print right-aligned total for this product with choices
          printer.alignRight();
          printer.println(
            tr(
              `${convertToDecimal(total + (product.quantity - 1) * product.total).toFixed(2)} €`,
              settings.transliterate
            )
          );
          printer.alignLeft();

          // Reset text size after bold
          changeTextSize(printer, settings?.textSize || 'NORMAL');

          // Draw separator
          drawLine2(printer);
        });

        if (vatBreakdown.length > 0) {
          console.log('vatBreakdown', vatBreakdown);
          changeTextSize(printer, settings?.textSize || 'NORMAL');
          // Print section headers
          printer.alignCenter();
          printer.println(
            tr(
              `${translations.printOrder.analysisVat[lang]}`,
              settings.transliterate
            )
          );
          printer.alignLeft();
          printer.println(
            `${tr(translations.printOrder.percentage[lang], settings.transliterate).padEnd(10)}${tr(translations.printOrder.netWorth[lang], settings.transliterate).padStart(15)}${tr(translations.printOrder.total[lang], settings.transliterate).padStart(15)}`
          );

          // Print each VAT item in a formatted row
          vatBreakdown.forEach((item) => {
            const vat = `${item.vat.toString()}%`.padEnd(10);

            // Use .toFixed(2) directly to round to 2 decimal places
            const netValue = item.netValue.toFixed(2).padStart(12); // netValue comes first
            const total = item.total.toFixed(2).padStart(18); // total comes second

            printer.println(`${vat}${netValue}${total}`); // Reversed order of printing
          });

          // Optionally print a footer or separator if needed
          printer.println('');
        }

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
        printer.alignRight();
        // Calculate total without VAT (net values)
        const totalNetValue = vatBreakdown.reduce(
          (sum, item) => sum + item.netValue,
          0
        );
        console.log('totalNetValue', totalNetValue);
        // Print total without VAT
        printer.println(
          tr(
            `${translations.printOrder.netWithoutVat[lang]}:${totalNetValue.toFixed(2)} €`,
            settings.transliterate
          )
        );
        // Print total (with VAT)
        printer.println(
          tr(
            `
            ${translations.printOrder.total[lang]}:${convertToDecimal(order.total).toFixed(2)} €`,
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
        printer.println(`${translations.printOrder.notReceiptNotice[lang]}`);
        printer.println(
          `${translations.printOrder.notReceiptNoticeContinue[lang]}`
        );
        printer.cut();
      }

      printer
        .execute({
          waitForResponse: false,
        })
        .then(() => {
          printer.clear();
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
