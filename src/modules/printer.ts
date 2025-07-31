/* eslint-disable no-plusplus */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-continue */
import {
  CharacterSet,
  printer as ThermalPrinter,
  types as PrinterTypes,
} from 'node-thermal-printer';
import { date, z } from 'zod';
import { Request, Response } from 'express';
import { Order } from '../resolvers/printOrders';
import { convertToDecimal, leftPad, tr } from './common';
import logger from './logger';
import { IPrinterSettings, ISettings, PrinterTextSize } from './settings';
import { SupportedLanguages, translations } from './translations';
import { exec } from 'child_process';
import { Z_FIXED } from 'zlib';
import { add } from 'nconf';
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
    connected = await printer?.isPrinterConnected();
  } else {
    try {
      const shareName = interfaceString.split('\\').pop() || '';
      connected = await isUsbPrinterOnline(shareName); // port = 'printerServer'
    } catch (error) {
      console.error('Error checking printer connection:', error);
      connected = false;
    }
  }
  if (!connected) {
    console.log('Printer not connected');
    printer?.clear();
    return 'Printer not connected';
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
  printer.setTextSize(1, 0);
  printer.println('text bigger');
  printer.setTextSize(0, 1);
  printer.println('text more height');
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
    const err = new Error('print failed');
    (err as any).cause = error;
    throw err;
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
export const pelatologioRecord = (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    printPelatologioRecord(
      req.body.pelatologioRecord as PelatologioRecord,
      req.body.lang || 'el'
    );
    res.status(200).send({ status: 'done' });
  } catch (error) {
    logger.error('Error printing test page:', error);
    res.status(400).send(error.message);
  }
};
export const parkingTicket = (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    printParkingTicket(
      req.body.venueName,
      req.body.license,
      req.body.address,
      req.body.phone,
      req.body.date,
      req.body.entryTime,
      req.body.operatingHours,
      req.body.lang || 'el'
    );
    res.status(200).send({ status: 'done' });
  } catch (error) {
    logger.error('Error printing test page:', error);
    res.status(400).send(error.message);
  }
};
const formatLine = (left, right) => {
  const space = 40 - left.length - right.length;
  return left + ' '.repeat(space > 0 ? space : 1) + right;
};
const printParkingTicket = async (
  venueName: string,
  license: string,
  address: string,
  phone: string,
  date: string,
  entryTime: string,
  operatingHours: string,
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
      /* if (settings.documentsToPrint !== undefined) {
        if (!settings.documentsToPrint?.includes('PARKINGTICKET')) {
          console.log('PARKINGTICKET is not in documentsToPrint');
          continue;
        }
      }*/
      printer.alignCenter();
      changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
      printer.bold(true);
      printer.println('PARKING TICKET');
      drawLine2(printer);
      printer.bold(false);
      printer.bold(true);
      printer.println(venueName);
      printer.bold(false);
      printer.println(address);
      printer.println(phone);
      drawLine2(printer);
      printer.alignLeft();
      printer.newLine();
      printer.println(formatLine('LICENSE:', license));
      printer.println(formatLine('DATE:', date));
      printer.println(formatLine('ENTRY TIME:', entryTime));
      printer.alignLeft();
      printer.println(formatLine('Operating Hours:', operatingHours));
      printer.bold(true);
      printer.alignCenter();
      printer.newLine();
      printer.println('IMPORTANT NOTICE');
      printer.bold(false);
      printer.println('Keep this ticket. Vehicle must exit before');

      printer.println(' closing time Overstay fees may apply');
      drawLine2(printer);
      printer.println('Thank you for parking with us!');
      printer.println('Keep this ticket for your records');
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
const formatToGreek = (date: Date | string): string => {
  const entryDate = new Date(date);
  return entryDate.toLocaleString('el-GR', {
    timeZone: 'Europe/Athens',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};
const printPelatologioRecord = async (
  pelatologioRecord: PelatologioRecord,
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

      printer.alignCenter();
      changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
      printer.bold(true);
      printer.println('PELATOLOGIO RECORD');
      printer.newLine();
      printer.alignLeft();
      printer.println(
        'SERVICE TYPE: ' +
          (pelatologioRecord.clientServiceType?.toUpperCase() || 'N/A')
      );
      printer.println('DCLID: ' + pelatologioRecord.dclId);
      printer.println('STATUS: ' + pelatologioRecord.status?.toUpperCase());
      printer.println(
        'CATEGORY: ' + pelatologioRecord.vehicleCategory?.toUpperCase()
      );
      if (pelatologioRecord.vehicleRegNumber) {
        printer.println('REG NUMBER: ' + pelatologioRecord.vehicleRegNumber);
      }
      if (pelatologioRecord.foreignVehicleRegNumber) {
        printer.println(
          'REG NUMBER: ' + pelatologioRecord.foreignVehicleRegNumber
        );
      }
      if (pelatologioRecord.dateTime) {
        printer.println(
          'TIME OF ENTRY: ' + formatToGreek(pelatologioRecord.dateTime)
        );
      }
      if (pelatologioRecord.completionDateTime) {
        printer.println(
          'COMPLETION DATE: ' +
            formatToGreek(pelatologioRecord.completionDateTime)
        );
      }
      if (pelatologioRecord.comments) {
        printer.println('COMMENTS: ' + pelatologioRecord.comments);
      }
      if (pelatologioRecord.amount) {
        printer.println('AMOUNT: ' + pelatologioRecord.amount.toFixed(2) + '€');
      }
      if (pelatologioRecord.cancellationReason) {
        printer.println(
          'CANCELLATION REASON: ' + pelatologioRecord.cancellationReason
        );
      }
      if (pelatologioRecord.nonIssueInvoice) {
        printer.println('TYPE OF INVOICE: INVOICE NOT ISSUED');
      }
      if (pelatologioRecord.fim) {
        printer.println('TYPE OF INVOICE: ΑΛΠ/ΑΠΥ/FIM');
        printer.println('FIMAA: ' + pelatologioRecord.fim.fimAA);
        printer.println('FIMNUMBER: ' + pelatologioRecord.fim.fimNumber);
        printer.println('FIMISSUE DATE: ' + pelatologioRecord.fim.fimIssueDate);
        printer.println('FIMISSUE TIME: ' + pelatologioRecord.fim.fimIssueTime);
      }
      if (pelatologioRecord.invoiceMark) {
        printer.println('TYPE OF INVOICE: ΑΛΠ/ΑΠΥ');
        printer.println('INVOICE MARK: ' + pelatologioRecord.invoiceMark);
      }
      printer.alignCenter();
      printer.newLine();
      printer.println('POWERED BY MYPELATES');
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
export const paymentSlip = (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    printPaymentSlip(
      req.body.aadeInvoice,
      req.body.issuerText,
      req.body.orderNumber,
      req.body.discount,
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
      req.body.discount,
      req.body.tip,
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
      req.body.orderNumber,
      req.body.issuerText,
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

interface PelatologioRecord {
  amount?: number;
  cancellationReason?: string;
  clientServiceType?: 'rental' | 'garage' | 'parkingcarwash';
  comments?: string;
  completionDateTime?: Date | string;
  contactId?: string; // ObjectId as string
  cooperatingVatNumber?: string;
  customerVatNumber?: string;
  dateTime?: Date | string;
  dclId?: number;
  entityVatNumber?: string;
  entryCompletion?: boolean;
  exitDateTime?: Date | string;
  fim?: {
    fimAA?: number;
    fimIssueDate?: string; // YYYY-MM-DD
    fimIssueTime?: string; // HH:mm:ss
    fimNumber?: string;
  };
  foreignVehicleRegNumber?: string;
  invoiceKind?: 'RECEIPT' | 'INVOICE' | 'FIM_RECEIPT';
  invoiceMark?: string;
  isDiffVehReturnLocation?: boolean;
  nonIssueInvoice?: boolean;
  offSiteProvidedService?: 'TEMPORARY_EXIT' | 'MOVE_TO_SAME_ENTITY';
  otherBranch?: number;
  providedServiceCategory?:
    | 'CATALOG_WORK'
    | 'CUSTOM_AGREEMENT'
    | 'DAMAGE_ASSESSMENT'
    | 'FREE_SERVICE'
    | 'OTHER'
    | 'WARRANTY_COMPENSATION';
  providedServiceCategoryOther?: string;
  reasonNonIssueType?:
    | 'FREE_SERVICE'
    | 'GUARANTEE_PROVISION_COMPENSATION'
    | 'SELF_USE';
  status?: 'active' | 'completed' | 'cancelled' | 'noInvoiceYet';
  updatesHistory?: {
    comments?: string;
    dateTime?: Date | string;
    updateInfo?: string;
    userId?: string; // ObjectId as string
  }[];
  vehicleCategory?: string;
  vehicleFactory?: string;
  vehicleId?: string; // ObjectId as string
  vehicleMovementPurpose?:
    | 'RENTAL'
    | 'REPAIR'
    | 'PERSONAL_USE'
    | 'FREE_SERVICE'
    | 'OTHER';
  vehicleRegNumber?: string;
  vehicleReturnLocation?: string;
  venueId?: string; // ObjectId as string
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

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
  gross_value: number;
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
  orderNumber: number,
  issuerText: string,
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
      printer.println(
        tr(`${translations.printOrder.orderForm[lang]}`, settings.transliterate)
      );
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
      printer.println(issuerText);
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
      // Second line: table and server
      printer.println(`${tableNumber},${waiterName.toUpperCase()}`);
      printer.println(
        `${aadeInvoice?.header.series.code}${aadeInvoice?.header.serial_number}`
      );
      printer.alignCenter();
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
        const value = (
          (detail.net_value || 0) + (detail?.tax?.value || 0)
        )?.toFixed(2);
        const vat = `${detail.tax.rate}%`; // "24%"
        printer.println(
          name.padEnd(18).substring(0, 18) + // Trim to 18 chars max
            quantity.padEnd(7) +
            value.padEnd(7) +
            vat
        );
        if (detail.rec_type === 7) {
          printer.println(` - ${translations.printOrder.itemRemoval[lang]}`);
        }
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
      printer.println(
        tr(`ΤΟ ΠΑΡΟΝ ΕΙΝΑΙ ΠΛΗΡΟΦΟΡΙΑΚΟ ΣΤΟΙΧΕΙΟ ΚΑΙ`, settings.transliterate)
      );
      printer.println(
        tr(`ΔΕΝ ΑΠΟΤΕΛΕΙ ΝΟΜΙΜΗ ΦΟΡΟΛΟΓΙΚΗ`, settings.transliterate)
      );
      printer.println(tr(`ΑΠΟΔΕΙΞΗ/ΤΙΜΟΛΟΓΙΟ.`, settings.transliterate));
      printer.newLine();
      printer.println(
        tr(`THE PRESENT DOCUMENT IS ISSUED ONLY FOR`, settings.transliterate)
      );
      printer.println(
        tr(`INFORMATION PURPOSES AND DOES NOT STAND`, settings.transliterate)
      );
      printer.println(
        tr(`FOR A VALID TAX RECEIPT/INVOICE`, settings.transliterate)
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
const printPaymentSlip = async (
  aadeInvoice: AadeInvoice,
  issuerText: string,
  orderNumber: number,
  discount: {
    amount: number;
    type: 'PERCENTAGE' | 'FIXED' | 'NONE';
  },
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
      let discountAmount = '';
      console.log(discount.type);
      if (discount.type !== undefined) {
        if (discount.type === 'FIXED') {
          discountAmount = (discount.amount / 100).toString() + '€';
        } else {
          discountAmount = discount.amount.toString() + '%';
        }
      }
      if (discountAmount !== '') {
        printer.println(
          `${translations.printOrder.discount[lang]}: ${discountAmount},${DISCOUNTTYPES[discount.type.toLocaleLowerCase()]?.label_el || ''}`
        );
      }
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
  takeAway: {
    value: 'takeAway',
    label_en: 'Take Away',
    label_el: 'Take Away',
  },
  dine_in: {
    value: 'dineIn',
    label_en: 'Dine In',
    label_el: 'Dine In',
  },
};

const DISCOUNTTYPES: Record<string, ServiceType> = {
  fixed: {
    value: 'fixed',
    label_en: 'Fixed',
    label_el: 'Σταθερή',
  },
  percent: {
    value: 'percent',
    label_en: 'Percentage',
    label_el: 'Ποσοστό',
  },
  none: {
    value: 'none',
    label_en: 'Unknown',
    label_el: 'Άγνωστη',
  },
};

const printPaymentReceipt = async (
  aadeInvoice: AadeInvoice,
  orderNumber: number,
  orderType: string,
  issuerText: string,
  discount:
    | {
        amount: number;
        type: 'PERCENTAGE' | 'FIXED' | 'NONE';
      }
    | {},
  tip: number,
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
            (detail.net_value || 0) + (detail?.tax?.value || 0)
          )?.toFixed(2);
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
        let discountAmount = '';
        if ('amount' in discount && 'type' in discount) {
          if (discount.type === 'FIXED') {
            discountAmount = (discount.amount / 100).toString() + '€';
          } else {
            discountAmount = discount.amount.toString() + '%';
          }
          if (discountAmount !== '') {
            printer.println(
              `${translations.printOrder.discount[lang]}: ${discountAmount},${DISCOUNTTYPES[discount.type.toLocaleLowerCase()]?.label_el || ''}`
            );
          }
        }
        if (tip > 0) {
          printer.println(
            `${translations.printOrder.tip[lang]}: ${(tip / 100).toFixed(2)}€`
          );
        }
        printer.bold(true);
        printer.alignLeft();

        const lineWidth = 42; // Adjust based on your printer (usually 32 or 42 characters at size 0,0)
        const leftText = `${translations.printOrder.items[lang]}: ${sumQuantity}`;
        const roundedSum = Number(sumAmount + tip / 100)
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
export const checkPrinters = async () => {
  const connectedPrinterIds: { id: string; connected: boolean }[] = [];

  for (let i = 0; i < printers.length; i += 1) {
    const settings = printers[i]?.[1];
    const printer = printers[i]?.[0];

    if (!settings || !printer) {
      continue;
    }
    console.log('printer', settings.id);
    try {
      //   const connected = await printer.isPrinterConnected();
      let connected = false;
      if (settings.ip !== '') {
        connected = await printer?.isPrinterConnected();
      } else {
        try {
          const shareName = settings.port.split('\\').pop() || '';
          connected = await isUsbPrinterOnline(shareName); // port = 'printerServer'
        } catch (error) {
          console.error('Error checking printer connection:', error);
          connected = false;
        }
      }

      if (connected) {
        connectedPrinterIds.push({ id: settings?.id || '', connected: true });
        // Use printer settings as identifier
        console.log('Printer connected:', printer);
      } else {
        connectedPrinterIds.push({ id: settings?.id || '', connected: false });
        printer?.clear();
      }
    } catch (error) {
      console.error('Error checking printer connection:', error);
    }
  }
  console.log('Connected printers:', connectedPrinterIds);
  return connectedPrinterIds;
};

export const printOrder = async (
  order: z.infer<typeof Order>,
  appId: string = 'desktop',
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
      let productsToPrint =
        order.orderType === 'EFOOD'
          ? order.products
          : order.products.filter((product) =>
              product.categories.some((category) =>
                settings?.categoriesToPrint?.includes(category)
              )
            );

      console.log(productsToPrint);
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
      const isEdit = order?.isEdit || false;
      if (isEdit === true) {
        productsToPrint = productsToPrint.filter(
          (product) =>
            product?.updateStatus?.includes('NEW') ||
            product?.updateStatus?.includes('UPDATED')
        );
      }
      const orderCreationDate = new Date(order.createdAt);
      const date =
        orderCreationDate.toISOString().split('T')[0]?.replace(/-/g, '/') || '';

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
          printer.setTextSize(1, 0);
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
          printer.setTextSize(1, 0);
        } else {
          changeTextSize(printer, settings?.textSize || 'NORMAL');
        }

        printer.print(
          tr(
            `${translations.printOrder.orderType[lang]}:`,
            settings.transliterate
          )
        );
        if (
          order.orderType === 'DINE_IN' ||
          order.orderType === 'TAKE_AWAY_INSIDE' ||
          order.orderType === 'TAKE_AWAY_PACKAGE'
        ) {
          printer.bold(true);
          printer.setTextSize(1, 0);
        }
        printer.println(
          `${translations.printOrder.orderTypes[order.orderType][lang]}`
        );
        printer.bold(false);
        printer.setTextSize(0, 0);
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
            customerName !== undefined &&
            customerName !== null &&
            customerName !== 'null' &&
            customerName !== 'undefined' &&
            customerName !== ''
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
                printer.bold(true);
                printer.setTextSize(1, 0);
                printer.bold(false);
                break;
              default:
                break;
            }
          });
        }
        const vatBreakdown: { vat: number; total: number; netValue: number }[] =
          [];

        printer.alignCenter();
        printer.println(
          tr(
            `${translations.printOrder.startOrder[lang]}`,
            settings.transliterate
          )
        );
        drawLine2(printer);
        printer.alignLeft();
        productsToPrint.forEach((product) => {
          let total = product.total || 0;
          const leftAmount = `${product.quantity}x `.length;
          if (appId !== 'kiosk' && settings.printerType === 'KIOSK') {
            console.log('Skipping product');
            return;
          }
          if (isEdit) {
            if (product.updateStatus?.includes('NEW')) {
              printer.println(`${translations.printOrder.new[lang]}`);
            }
            if (
              product.updateStatus?.includes('UPDATED') &&
              product.quantityChanged &&
              isEdit
            ) {
              printer.println(
                `${translations.printOrder.quantityChanged[lang]}`
              );
            } else if (product.updateStatus?.includes('UPDATED')) {
              printer.println(`${translations.printOrder.updated[lang]}`);
            }
          }
          // Bold if enabled
          if (settings.textOptions.includes('BOLD_PRODUCTS')) {
            printer.bold(true);
            printer.setTextSize(1, 0);
            printer.bold(false);
          } else {
            changeTextSize(printer, settings?.textSize || 'NORMAL');
          }

          // Pad title and amount for alignment
          let productLine = `${product.quantity}x ${product.title}`;
          if (
            product.updateStatus?.includes('NEW') &&
            isEdit &&
            product.quantityChanged
          ) {
            productLine = `${product.quantity}x ${product.title}`;
          } else if (isEdit && product.quantityChanged) {
            productLine = `${product.quantityChanged.was} -> ${product.quantity}x ${product.title}`;
          }

          let priceStr = '';
          if (
            settings.priceOnOrder === undefined ||
            settings.priceOnOrder === true
          ) {
            priceStr = product.total
              ? `${convertToDecimal(product.total).toFixed(2)} €`
              : '';
          }
          const lineWidth = 42; // Assuming 42 character width for POS80
          const paddedLine =
            productLine.padEnd(lineWidth - priceStr.length, ' ') + priceStr;

          printer.println(tr(paddedLine, settings.transliterate));

          // Handle product choices
          product.choices?.forEach((choice) => {
            total += (choice.price || 0) * (choice.quantity || 1);
            const choiceLine = `- ${Number(choice.quantity) > 1 ? `${choice.quantity}x ` : ''}${choice.title}`;
            let choicePrice = '';
            if (
              settings.priceOnOrder === undefined ||
              settings.priceOnOrder === true
            ) {
              choicePrice = choice.price
                ? `+${convertToDecimal(choice.price * (choice.quantity || 1)).toFixed(2)} €`
                : '';
            }
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
          if (
            (product.vat && settings.priceOnOrder === undefined) ||
            settings.priceOnOrder === true
          ) {
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
            const rawNet = rawTotal / (1 + (vatRate || 0) / 100);

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
                vat: vatRate || 0,
                total: fullTotal,
                netValue: netValue,
              });
            }
          }

          // Print right-aligned total for this product with choices
          if (
            settings.priceOnOrder === undefined ||
            settings.priceOnOrder === true
          ) {
            printer.alignRight();
            printer.println(
              tr(
                `${convertToDecimal(total + (product.quantity - 1) * product.total).toFixed(2)} €`,
                settings.transliterate
              )
            );
          }
          printer.alignLeft();

          // Reset text size after bold
          changeTextSize(printer, settings?.textSize || 'NORMAL');

          // Draw separator
          drawLine2(printer);
        });
        if (
          vatBreakdown.length > 0 &&
          (settings.vatAnalysis === true || settings.vatAnalysis === undefined)
        ) {
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

        if (order.tip && settings.priceOnOrder) {
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
        if (
          settings.vatAnalysis === true ||
          settings.vatAnalysis === undefined
        ) {
          // Print total without VAT
          printer.println(
            tr(
              `${translations.printOrder.netWithoutVat[lang]}:${totalNetValue.toFixed(2)} €`,
              settings.transliterate
            )
          );
        }
        // Print total (with VAT)
        if (
          settings.priceOnOrder === undefined ||
          settings.priceOnOrder === true
        ) {
          printer.println(
            tr(
              `${translations.printOrder.total[lang]}:${convertToDecimal(order.total).toFixed(2)} €`,
              settings.transliterate
            )
          );
        }

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
