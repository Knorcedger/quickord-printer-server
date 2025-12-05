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
import {
  convertToDecimal,
  tr,
  normalizeGreek,
  changeTextSize,
  PaymentMethod,
  readMarkdown,
  formatToGreek,
  formatLine,
  drawLine2,
  DISCOUNTTYPES,
  printMarks,
  printProducts,
  printPayments,
  printDiscountAndTip,
  printVatBreakdown,
  venueData,
  receiptData,
} from './common';
import logger from './logger';
import { IPrinterSettings, ISettings, PrinterTextSize } from './settings';
import { SupportedLanguages, translations } from './translations';
import { exec } from 'child_process';
import { PelatologioRecord, AadeInvoice } from './interfaces';

// Custom error classes for better error handling
export class PrinterError extends Error {
  constructor(
    message: string,
    public readonly printerName?: string,
    public readonly operation?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'PrinterError';
  }
}

export class PrinterConnectionError extends PrinterError {
  constructor(printerName: string, cause?: unknown) {
    super(
      `Failed to connect to printer: ${printerName}`,
      printerName,
      'connect',
      cause
    );
    this.name = 'PrinterConnectionError';
  }
}

export class PrinterExecutionError extends PrinterError {
  constructor(operation: string, printerName?: string, cause?: unknown) {
    super(`Failed to execute ${operation}`, printerName, operation, cause);
    this.name = 'PrinterExecutionError';
  }
}

export class InvalidInputError extends Error {
  constructor(
    message: string,
    public readonly field?: string
  ) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

// Helper function to determine status and HTTP code based on print results
export const determinePrintStatus = (
  successes: string[],
  errors: Array<{ printerIdentifier: string; error: unknown }>,
  skipped: Array<{ printerIdentifier: string; reason: string }>
): { status: string; httpCode: number } => {
  const hasSuccesses = successes.length > 0;
  const hasErrors = errors.length > 0;
  const hasSkipped = skipped.length > 0;

  // At least one printer succeeded → 200
  if (hasSuccesses) {
    return { status: 'success', httpCode: 200 };
  }

  // All printers skipped (nothing succeeded, nothing failed) → 200
  if (!hasSuccesses && !hasErrors && hasSkipped) {
    return { status: 'skipped', httpCode: 200 };
  }

  // All printers failed (no successes) → 200
  if (hasErrors && !hasSuccesses) {
    return { status: 'failed', httpCode: 200 };
  }

  // Fallback: no printers at all
  return { status: 'skipped', httpCode: 200 };
};

export const DEFAULT_CODE_PAGE = 7;
const printers: [ThermalPrinter, IPrinterSettings][] = [];

export const changeCodePage = (printer: ThermalPrinter, codePage: number) => {
  printer.add(Buffer.from([0x1b, 0x74, codePage]));
};

// Helper function to execute printer with proper error handling
const executePrinter = async (
  printer: ThermalPrinter,
  printerIdentifier: string,
  operation: string,
  context?: Record<string, any>
): Promise<void> => {
  try {
    await printer.execute({ waitForResponse: false });
    printer?.clear();
    logger.info(
      `Successfully executed ${operation} on ${printerIdentifier}`,
      context
    );
  } catch (error) {
    printer?.clear();

    // Check if it's a connection error
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isConnectionError =
      errorMessage.toLowerCase().includes('connect') ||
      errorMessage.toLowerCase().includes('timeout') ||
      errorMessage.toLowerCase().includes('network') ||
      errorMessage.toLowerCase().includes('econnrefused');

    if (isConnectionError) {
      logger.error(`Printer connection error on ${printerIdentifier}:`, {
        operation,
        error: errorMessage,
        printerIdentifier,
        ...context,
      });
      throw new PrinterConnectionError(printerIdentifier, error);
    } else {
      logger.error(`Printer execution error on ${printerIdentifier}:`, {
        operation,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        printerIdentifier,
        ...context,
      });
      throw new PrinterExecutionError(operation, printerIdentifier, error);
    }
  }
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

const isUsbPrinterOnline = (shareName: string): Promise<boolean> => {
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
};

export const checkPrinters = async () => {
  const connectedPrinterIds: { id: string; connected: boolean }[] = [];

  for (let i = 0; i < printers.length; i += 1) {
    const settings = printers[i]?.[1];
    const printer = printers[i]?.[0];

    if (!settings || !printer) {
      logger.warn(
        'Skipping printer check: missing settings or printer instance',
        { index: i }
      );
      continue;
    }

    const printerIdentifier =
      settings.name || settings.id || settings.ip || settings.port;
    logger.info(`Checking printer connection: ${printerIdentifier}`);

    try {
      let connected = false;
      if (settings.ip !== '') {
        connected = await printer?.isPrinterConnected();
        logger.info(
          `Network printer ${printerIdentifier} connection status: ${connected}`
        );
      } else {
        try {
          const shareName = settings.port.split('\\').pop() || '';
          connected = await isUsbPrinterOnline(shareName);
          logger.info(
            `USB printer ${printerIdentifier} (${shareName}) connection status: ${connected}`
          );
        } catch (error) {
          logger.error(
            `Error checking USB printer ${printerIdentifier} connection:`,
            {
              error: error instanceof Error ? error.message : String(error),
              shareName: settings.port,
            }
          );
          connected = false;
        }
      }

      if (connected) {
        connectedPrinterIds.push({ id: settings?.id || '', connected: true });
        logger.info(`Printer ${printerIdentifier} is online`);
      } else {
        connectedPrinterIds.push({ id: settings?.id || '', connected: false });
        printer?.clear();
        logger.warn(`Printer ${printerIdentifier} is offline, clearing buffer`);
      }
    } catch (error) {
      logger.error(`Error checking printer ${printerIdentifier} connection:`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      connectedPrinterIds.push({ id: settings?.id || '', connected: false });
    }
  }

  logger.info('Printer connection check complete', {
    connectedPrinters: connectedPrinterIds,
  });
  return connectedPrinterIds;
};

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

export const pelatologioRecord = async (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    if (!req.body.pelatologioRecord) {
      throw new InvalidInputError(
        'pelatologioRecord is required',
        'pelatologioRecord'
      );
    }

    const result = await printPelatologioRecord(
      req.body.pelatologioRecord as PelatologioRecord,
      req.body.lang || 'el'
    );

    // Format the response with detailed printer status
    const response: any = {
      status: 'success',
      successfulPrinters: result.successes,
      failedPrinters: result.errors.map((e) => ({
        printer: e.printerIdentifier,
        error: e.error instanceof Error ? e.error.message : String(e.error),
      })),
    };

    res.status(200).send(response);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      logger.error(`Invalid input for pelatologio record: ${error.message}`, {
        field: error.field,
      });
      return res.status(400).send({ error: error.message, field: error.field });
    }

    logger.error('Error printing pelatologio record:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(200).send({ status: 'failed', error: errorMessage });
  }
};

const printTextFunc = async (
  text: string,
  alignment: 'left' | 'center' | 'right',
  copies: number = 1,
  lang: SupportedLanguages = 'el'
) => {
  let successCount = 0;
  const errors: Array<{ printerIdentifier: string; error: unknown }> = [];
  const successes: string[] = [];

  for (let i = 0; i < printers.length; i += 1) {
    const settings = printers[i]?.[1];
    const printer = printers[i]?.[0];
    const printerIdentifier =
      settings?.name ||
      (settings as IPrinterSettings)?.id ||
      (settings as IPrinterSettings)?.ip ||
      settings?.port ||
      `printer-${i}`;

    if (!settings || !printer) {
      logger.warn(
        `Skipping text print: missing settings or printer instance for ${printerIdentifier}`
      );
      errors.push({
        printerIdentifier,
        error: 'Printer not configured or missing settings',
      });
      continue;
    }

    if (!settings.documentsToPrint?.includes('TEXT')) {
      logger.warn(
        `Skipping text print: TEXT not in documentsToPrint for ${printerIdentifier}`
      );
      errors.push({
        printerIdentifier,
        error: 'Printer not configured to print TEXT documents',
      });
      continue;
    }

    for (let j = 0; j < copies; j += 1) {
      logger.info(
        `Printing text copy ${j + 1} of ${copies} on ${printerIdentifier}`
      );

      try {
        changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
        printer.clear();

        await readMarkdown(text, printer, alignment, settings);
        printer.cut();

        await printer.execute({
          waitForResponse: false,
        });

        logger.info(`Successfully printed text to ${printerIdentifier}`, {
          copy: j + 1,
          totalCopies: copies,
        });
        successCount++;
        if (j === 0) {
          successes.push(printerIdentifier);
        }

        // Add delay between copies to ensure printer finishes processing
        if (j < copies - 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          printer?.clear();
        }
      } catch (error) {
        errors.push({ printerIdentifier, error });
        if (error instanceof PrinterConnectionError) {
          logger.error(
            `Cannot print text - printer ${printerIdentifier} is not connected or unreachable`
          );
        } else {
          logger.error(`Failed to print text to ${printerIdentifier}:`, {
            error: error instanceof Error ? error.message : String(error),
            copy: j + 1,
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
        break; // Skip remaining copies for this printer
      }
    }
  }

  // If no printers succeeded, throw an error
  if (successCount === 0 && errors.length > 0) {
    const errorMessages = errors.map(
      (e) =>
        `${e.printerIdentifier}: ${e.error instanceof Error ? e.error.message : String(e.error)}`
    );
    throw new PrinterError(
      `Failed to print text to any printer. Errors: ${errorMessages.join('; ')}`
    );
  }

  return { successes, errors };
};
export const printText = async (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    if (!req.body.text) {
      throw new InvalidInputError('text is required', 'text');
    }

    const validAlignments = ['left', 'center', 'right'];
    if (req.body.alignment && !validAlignments.includes(req.body.alignment)) {
      throw new InvalidInputError(
        `alignment must be one of: ${validAlignments.join(', ')}`,
        'alignment'
      );
    }

    const result = await printTextFunc(
      req.body.text,
      req.body.alignment || 'left',
      req.body.copies || 1,
      req.body.lang || 'el'
    );

    // Format the response with detailed printer status
    const response: any = {
      status: 'success',
      successfulPrinters: result.successes,
      failedPrinters: result.errors.map((e) => ({
        printer: e.printerIdentifier,
        error: e.error instanceof Error ? e.error.message : String(e.error),
      })),
    };

    res.status(200).send(response);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      logger.error(`Invalid input for print text: ${error.message}`, {
        field: error.field,
      });
      return res.status(400).send({ error: error.message, field: error.field });
    }

    logger.error('Error printing text:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(200).send({ status: 'failed', error: errorMessage });
  }
};
export const parkingTicket = async (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    const requiredFields = [
      'venueName',
      'license',
      'address',
      'phone',
      'date',
      'entryTime',
      //'operatingHours',
    ];
    for (const field of requiredFields) {
      if (!req.body[field]) {
        throw new InvalidInputError(`${field} is required`, field);
      }
    }

    const result = await printParkingTicket(
      req.body.venueName,
      req.body.license,
      req.body.address,
      req.body.phone,
      req.body.date,
      req.body.entryTime,
      //  req.body.operatingHours,
      req.body.lang || 'el'
    );

    // Format the response with detailed printer status
    const response: any = {
      status: 'success',
      successfulPrinters: result.successes,
      failedPrinters: result.errors.map((e) => ({
        printer: e.printerIdentifier,
        error: e.error instanceof Error ? e.error.message : String(e.error),
      })),
    };

    res.status(200).send(response);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      logger.error(`Invalid input for parking ticket: ${error.message}`, {
        field: error.field,
      });
      return res.status(400).send({ error: error.message, field: error.field });
    }

    logger.error('Error printing parking ticket:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(200).send({ status: 'failed', error: errorMessage });
  }
};

const printParkingTicket = async (
  venueName: string,
  license: string,
  address: string,
  phone: string,
  date: string,
  entryTime: string,
  // operatingHours: string,
  lang: SupportedLanguages = 'el'
) => {
  let successCount = 0;
  const errors: Array<{ printerIdentifier: string; error: unknown }> = [];
  const successes: string[] = [];

  for (let i = 0; i < printers.length; i += 1) {
    const settings = printers[i]?.[1];
    const printer = printers[i]?.[0];
    const printerIdentifier =
      settings?.name ||
      (settings as IPrinterSettings)?.id ||
      settings?.ip ||
      settings?.port ||
      `printer-${i}`;

    try {
      if (!settings || !printer) {
        logger.warn(
          `Skipping parking ticket print: missing settings or printer instance for ${printerIdentifier}`
        );
        errors.push({
          printerIdentifier,
          error: 'Printer not configured or missing settings',
        });
        continue;
      }

      printer.clear();
      logger.info(`Printing parking ticket to ${printerIdentifier}`, {
        license,
        venueName,
      });

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
      //   printer.println(formatLine('Operating Hours:', operatingHours));
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

      await printer.execute({
        waitForResponse: false,
      });

      printer?.clear();
      logger.info(
        `Successfully printed parking ticket to ${printerIdentifier}`,
        { license }
      );
      successCount++;
      successes.push(printerIdentifier);
    } catch (error) {
      errors.push({ printerIdentifier, error });
      if (error instanceof PrinterConnectionError) {
        logger.error(
          `Cannot print parking ticket - printer ${printerIdentifier} is not connected or unreachable`
        );
      } else {
        logger.error(
          `Failed to print parking ticket to ${printerIdentifier}:`,
          {
            error: error instanceof Error ? error.message : String(error),
            license,
            stack: error instanceof Error ? error.stack : undefined,
          }
        );
      }
    }
  }

  // If no printers succeeded, throw an error
  if (successCount === 0 && errors.length > 0) {
    const errorMessages = errors.map(
      (e) =>
        `${e.printerIdentifier}: ${e.error instanceof Error ? e.error.message : String(e.error)}`
    );
    throw new PrinterError(
      `Failed to print parking ticket to any printer. Errors: ${errorMessages.join('; ')}`
    );
  }

  return { successes, errors };
};

const printPelatologioRecord = async (
  pelatologioRecord: PelatologioRecord,
  lang: SupportedLanguages = 'el'
) => {
  let successCount = 0;
  const errors: Array<{ printerIdentifier: string; error: unknown }> = [];
  const successes: string[] = [];

  for (let i = 0; i < printers.length; i += 1) {
    const settings = printers[i]?.[1];
    const printer = printers[i]?.[0];
    const printerIdentifier =
      settings?.name ||
      settings?.id ||
      settings?.ip ||
      settings?.port ||
      `printer-${i}`;

    try {
      if (!settings || !printer) {
        logger.warn(
          `Skipping pelatologio record print: missing settings or printer instance for ${printerIdentifier}`
        );
        errors.push({
          printerIdentifier,
          error: 'Printer not configured or missing settings',
        });
        continue;
      }

      printer.clear();
      logger.info(`Printing pelatologio record to ${printerIdentifier}`, {
        dclId: pelatologioRecord.dclId,
        status: pelatologioRecord.status,
      });

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

      await printer.execute({
        waitForResponse: false,
      });

      printer?.clear();
      logger.info(
        `Successfully printed pelatologio record to ${printerIdentifier}`,
        { dclId: pelatologioRecord.dclId }
      );
      successCount++;
      successes.push(printerIdentifier);
    } catch (error) {
      errors.push({ printerIdentifier, error });
      if (error instanceof PrinterConnectionError) {
        logger.error(
          `Cannot print pelatologio record - printer ${printerIdentifier} is not connected or unreachable`
        );
      } else {
        logger.error(
          `Failed to print pelatologio record to ${printerIdentifier}:`,
          {
            error: error instanceof Error ? error.message : String(error),
            dclId: pelatologioRecord.dclId,
            stack: error instanceof Error ? error.stack : undefined,
          }
        );
      }
    }
  }

  // If no printers succeeded, throw an error
  if (successCount === 0 && errors.length > 0) {
    const errorMessages = errors.map(
      (e) =>
        `${e.printerIdentifier}: ${e.error instanceof Error ? e.error.message : String(e.error)}`
    );
    throw new PrinterError(
      `Failed to print pelatologio record to any printer. Errors: ${errorMessages.join('; ')}`
    );
  }

  return { successes, errors };
};
export const paymentSlip = async (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    if (!req.body.aadeInvoice) {
      throw new InvalidInputError('aadeInvoice is required', 'aadeInvoice');
    }
    if (req.body.orderNumber === undefined || req.body.orderNumber === null) {
      throw new InvalidInputError('orderNumber is required', 'orderNumber');
    }

    // Normalize discount/discounts to array format from order object
    let discountsArray: any[] = [];
    const order = req.body.order;
    if (order?.discounts) {
      // If discounts exists, convert to array if needed
      discountsArray = Array.isArray(order.discounts)
        ? order.discounts
        : [order.discounts];
    } else if (order?.discount && Object.keys(order.discount).length > 0) {
      // Backward compatibility: use old discount field if discounts doesn't exist
      discountsArray = [order.discount];
    }

    const result = await printPaymentSlip(
      req.body.aadeInvoice,
      req.body.issuerText || '',
      req.body.orderNumber,
      discountsArray,
      (Array.isArray(req.headers.project)
        ? req.headers.project[0]
        : req.headers.project) || 'centrix',
      req.body.lang || 'el'
    );

    // Format the response with detailed printer status
    const response: any = {
      status: 'success',
      successfulPrinters: result.successes,
      failedPrinters: result.errors.map((e) => ({
        printer: e.printerIdentifier,
        error: e.error instanceof Error ? e.error.message : String(e.error),
      })),
    };

    res.status(200).send(response);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      logger.error(`Invalid input for payment slip: ${error.message}`, {
        field: error.field,
      });
      return res.status(400).send({ error: error.message, field: error.field });
    }

    logger.error('Error printing payment slip:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(200).send({ status: 'failed', error: errorMessage });
  }
};
export const paymentReceipt = async (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    if (!req.body.aadeInvoice) {
      throw new InvalidInputError('aadeInvoice is required', 'aadeInvoice');
    }
    if (req.body.orderNumber === undefined || req.body.orderNumber === null) {
      throw new InvalidInputError('orderNumber is required', 'orderNumber');
    }

    // Normalize discount/discounts to array format from order object
    let discountsArray: any[] = [];
    const order = req.body.order;
    console.log('order?.discounts:', order?.discounts);
    console.log('order?.discount:', order?.discount);
    if (order?.discounts) {
      // If discounts exists, convert to array if needed
      discountsArray = Array.isArray(order.discounts)
        ? order.discounts
        : [order.discounts];
    } else if (order?.discount && Object.keys(order.discount).length > 0) {
      // Backward compatibility: use old discount field if discounts doesn't exist
      discountsArray = [order.discount];
    }
    console.log('Normalized discountsArray:', JSON.stringify(discountsArray));

    const result = await printPaymentReceipt(
      req.body.aadeInvoice,
      req.body.orderNumber,
      req.body.orderType || '',
      req.body.issuerText || '',
      discountsArray,
      req.body.tip || 0,
      req.body.appId || 'desktop',
      (Array.isArray(req.headers.project)
        ? req.headers.project[0]
        : req.headers.project) || 'centrix',
      order || null,
      req.body.lang || 'el'
    );

    // Determine the appropriate status and HTTP code
    const { status, httpCode } = determinePrintStatus(
      result.successes,
      result.errors,
      result.skipped
    );

    // Format the response with detailed printer status
    const response: any = {
      status,
      successfulPrinters: result.successes,
      failedPrinters: result.errors.map((e) => ({
        printer: e.printerIdentifier,
        error: e.error instanceof Error ? e.error.message : String(e.error),
      })),
      skippedPrinters: result.skipped.map((s) => ({
        printer: s.printerIdentifier,
        reason: s.reason,
      })),
    };

    res.status(httpCode).send(response);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      logger.error(`Invalid input for payment receipt: ${error.message}`, {
        field: error.field,
      });
      return res.status(400).send({ error: error.message, field: error.field });
    }

    logger.error('Error printing payment receipt:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(200).send({ status: 'failed', error: errorMessage });
  }
};
export const invoice = async (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    if (!req.body.aadeInvoice) {
      throw new InvalidInputError('aadeInvoice is required', 'aadeInvoice');
    }
    if (req.body.orderNumber === undefined || req.body.orderNumber === null) {
      throw new InvalidInputError('orderNumber is required', 'orderNumber');
    }

    // Normalize discount/discounts to array format from order object
    let discountsArray: any[] = [];
    const order = req.body.order;
    if (order?.discounts) {
      // If discounts exists, convert to array if needed
      discountsArray = Array.isArray(order.discounts)
        ? order.discounts
        : [order.discounts];
    } else if (order?.discount && Object.keys(order.discount).length > 0) {
      // Backward compatibility: use old discount field if discounts doesn't exist
      discountsArray = [order.discount];
    }

    const result = await printInvoice(
      req.body.aadeInvoice,
      req.body.orderNumber,
      req.body.orderType || '',
      req.body.issuerText || '',
      discountsArray,
      req.body.tip || 0,
      req.body.appId || 'desktop',
      (Array.isArray(req.headers.project)
        ? req.headers.project[0]
        : req.headers.project) || 'centrix',
      order || null,
      req.body.lang || 'el'
    );

    // Determine the appropriate status and HTTP code
    const { status, httpCode } = determinePrintStatus(
      result.successes,
      result.errors,
      result.skipped
    );

    // Format the response with detailed printer status
    const response: any = {
      status,
      successfulPrinters: result.successes,
      failedPrinters: result.errors.map((e) => ({
        printer: e.printerIdentifier,
        error: e.error instanceof Error ? e.error.message : String(e.error),
      })),
      skippedPrinters: result.skipped.map((s) => ({
        printer: s.printerIdentifier,
        reason: s.reason,
      })),
    };

    res.status(httpCode).send(response);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      logger.error(`Invalid input for invoice: ${error.message}`, {
        field: error.field,
      });
      return res.status(400).send({ error: error.message, field: error.field });
    }

    logger.error('Error printing invoice:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(200).send({ status: 'failed', error: errorMessage });
  }
};

export const invoiceMyPelates = async (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    if (!req.body.aadeInvoice) {
      throw new InvalidInputError('aadeInvoice is required', 'aadeInvoice');
    }

    const result = await printMyPelatesInvoice(
      req.body.aadeInvoice,
      req.body.issuerText || '',
      req.body.lang || 'el'
    );

    // Determine the appropriate status and HTTP code
    const { status, httpCode } = determinePrintStatus(
      result.successes,
      result.errors,
      result.skipped
    );

    // Format the response with detailed printer status
    const response: any = {
      status,
      successfulPrinters: result.successes,
      failedPrinters: result.errors.map((e) => ({
        printer: e.printerIdentifier,
        error: e.error instanceof Error ? e.error.message : String(e.error),
      })),
      skippedPrinters: result.skipped.map((s) => ({
        printer: s.printerIdentifier,
        reason: s.reason,
      })),
    };

    res.status(httpCode).send(response);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      logger.error(`Invalid input for MyPelates invoice: ${error.message}`, {
        field: error.field,
      });
      return res.status(400).send({ error: error.message, field: error.field });
    }

    logger.error('Error printing MyPelates invoice:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(200).send({ status: 'failed', error: errorMessage });
  }
};

export const paymentMyPelatesReceipt = async (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    if (!req.body.aadeInvoice) {
      throw new InvalidInputError('aadeInvoice is required', 'aadeInvoice');
    }

    const result = await printMyPelatesReceipt(
      req.body.aadeInvoice,
      req.body.issuerText || '',
      req.body.lang || 'el'
    );

    // Determine the appropriate status and HTTP code
    const { status, httpCode } = determinePrintStatus(
      result.successes,
      result.errors,
      result.skipped
    );

    // Format the response with detailed printer status
    const response: any = {
      status,
      successfulPrinters: result.successes,
      failedPrinters: result.errors.map((e) => ({
        printer: e.printerIdentifier,
        error: e.error instanceof Error ? e.error.message : String(e.error),
      })),
      skippedPrinters: result.skipped.map((s) => ({
        printer: s.printerIdentifier,
        reason: s.reason,
      })),
    };

    res.status(httpCode).send(response);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      logger.error(`Invalid input for MyPelates receipt: ${error.message}`, {
        field: error.field,
      });
      return res.status(400).send({ error: error.message, field: error.field });
    }

    logger.error('Error printing MyPelates receipt:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(200).send({ status: 'failed', error: errorMessage });
  }
};
export const orderForm = async (
  req: Request<{}, any, any>,
  res: Response<{}, any>
) => {
  try {
    if (!req.body.aadeInvoice) {
      throw new InvalidInputError('aadeInvoice is required', 'aadeInvoice');
    }
    if (req.body.orderNumber === undefined || req.body.orderNumber === null) {
      throw new InvalidInputError('orderNumber is required', 'orderNumber');
    }

    const result = await printOrderForm(
      req.body.aadeInvoice,
      req.body.table || '',
      req.body.waiter || '',
      req.body.orderNumber,
      req.body.issuerText || '',
      (Array.isArray(req.headers.project)
        ? req.headers.project[0]
        : req.headers.project) || 'centrix',
      req.body.order || null,
      req.body.lang || 'el'
    );

    // Format the response with detailed printer status
    const response: any = {
      status: 'success',
      successfulPrinters: result.successes,
      failedPrinters: result.errors.map((e) => ({
        printer: e.printerIdentifier,
        error: e.error instanceof Error ? e.error.message : String(e.error),
      })),
    };

    res.status(200).send(response);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      logger.error(`Invalid input for order form: ${error.message}`, {
        field: error.field,
      });
      return res.status(400).send({ error: error.message, field: error.field });
    }

    logger.error('Error printing order form:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(200).send({ status: 'failed', error: errorMessage });
  }
};

const printOrderForm = async (
  aadeInvoice: AadeInvoice,
  tableNumber: string,
  waiterName: string,
  orderNumber: number,
  issuerText: string,
  project: string = 'centrix',
  order: any = null,
  lang: SupportedLanguages = 'el'
) => {
  let successCount = 0;
  const errors: Array<{ printerIdentifier: string; error: unknown }> = [];
  const successes: string[] = [];

  for (let i = 0; i < printers.length; i += 1) {
    const settings = printers[i]?.[1];
    const printer = printers[i]?.[0];
    const printerIdentifier =
      settings?.name ||
      settings?.id ||
      settings?.ip ||
      settings?.port ||
      `printer-${i}`;

    try {
      printer?.clear();
      if (!settings || !printer) {
        errors.push({
          printerIdentifier,
          error: 'Printer not configured or missing settings',
        });
        continue;
      }
      if (settings.documentsToPrint !== undefined) {
        if (!settings.documentsToPrint?.includes('ORDERFORM')) {
          console.log('ORDERFORM is not in documentsToPrint');
          errors.push({
            printerIdentifier,
            error: 'Printer not configured to print ORDERFORM documents',
          });
          continue;
        }
      }
      console.log(aadeInvoice);
      printer.alignCenter();
      changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
      printer.println(
        tr(`${translations.printOrder.orderForm[lang]}`, settings.transliterate)
      );
      await venueData(printer, aadeInvoice, issuerText, settings, lang);
      receiptData(printer, aadeInvoice, settings, orderNumber, 'DINE_IN', lang);
      printer.println(`${tableNumber},${waiterName.toUpperCase()}`);
      if (aadeInvoice.closed) {
        printer.setTextSize(1, 0);
        printer.bold(true);
        printer.println(`${translations.printOrder.closed[lang]}`);
        printer.setTextSize(0, 0);
      }
      const [sumAmount, sumQuantity, fixedBreakdown] = printProducts(
        printer,
        aadeInvoice,
        order,
        settings,
        lang
      );
      printMarks(printer, aadeInvoice, lang);
      if (settings.poweredByQuickord) {
        printer.println(
          tr(`POWERED BY ${project.toUpperCase()}`, settings.transliterate)
        );
      }
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

      await executePrinter(printer, printerIdentifier, 'order form print', {
        orderNumber,
        tableNumber,
      });
      successCount++;
      successes.push(printerIdentifier);
    } catch (error) {
      errors.push({ printerIdentifier, error });
      if (error instanceof PrinterConnectionError) {
        logger.error(
          `Cannot print order form - printer ${printerIdentifier} is not connected or unreachable`
        );
      } else {
        logger.error(`Failed to print order form to ${printerIdentifier}:`, {
          error: error instanceof Error ? error.message : String(error),
          orderNumber,
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
  }

  // If no printers succeeded, throw an error
  if (successCount === 0 && errors.length > 0) {
    const errorMessages = errors.map(
      (e) =>
        `${e.printerIdentifier}: ${e.error instanceof Error ? e.error.message : String(e.error)}`
    );
    throw new PrinterError(
      `Failed to print order form to any printer. Errors: ${errorMessages.join('; ')}`
    );
  }

  return { successes, errors };
};
const printPaymentSlip = async (
  aadeInvoice: AadeInvoice,
  issuerText: string,
  orderNumber: number,
  discounts: any[] = [],
  project: string = 'centrix',
  lang: SupportedLanguages = 'el'
) => {
  let successCount = 0;
  const errors: Array<{ printerIdentifier: string; error: unknown }> = [];
  const successes: string[] = [];

  for (let i = 0; i < printers.length; i += 1) {
    const settings = printers[i]?.[1];
    const printer = printers[i]?.[0];
    const printerIdentifier =
      settings?.name ||
      settings?.id ||
      settings?.ip ||
      settings?.port ||
      `printer-${i}`;

    try {
      printer?.clear();
      if (!settings || !printer) {
        errors.push({
          printerIdentifier,
          error: 'Printer not configured or missing settings',
        });
        continue;
      }
      if (settings.documentsToPrint !== undefined) {
        if (!settings.documentsToPrint?.includes('PAYMENT-SLIP')) {
          console.log('PAYMENT-SLIP is not in documentsToPrint');
          errors.push({
            printerIdentifier,
            error: 'Printer not configured to print PAYMENT-SLIP documents',
          });
          continue;
        }
      }

      printer.alignCenter();
      changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
      printer.println(`${translations.printOrder.paymentSlip[lang]}`);
      printer.println(aadeInvoice?.issuer.name);
      printer.println(aadeInvoice?.issuer.activity);
      printer.println(
        `${aadeInvoice?.issuer.address.street} ${aadeInvoice?.issuer.address.city}, τκ:${aadeInvoice?.issuer.address.postal_code}`
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
        const quantity = detail.quantity.toFixed(0);
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
      // Print only overall discounts (not product-specific)
      const overallDiscounts = discounts.filter((d: any) => !d.productId);
      overallDiscounts.forEach((discount: any) => {
        if (discount.amount && discount.type) {
          let discountAmount = '';
          if (discount.type === 'FIXED') {
            discountAmount = (discount.amount / 100).toString() + '€';
          } else if (
            discount.type === 'PERCENTAGE' ||
            discount.type === 'PERCENT'
          ) {
            discountAmount = discount.amount.toString() + '%';
          }
          if (discountAmount !== '') {
            printer.println(
              `${translations.printOrder.discount[lang]}: ${discountAmount},${DISCOUNTTYPES[discount.type.toLocaleLowerCase()]?.label_el || ''}`
            );
          }
        }
      });
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
          PaymentMethod[detail.code]?.description ||
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
      const url = aadeInvoice?.url;

      let providerUrl = '';

      if (url.includes('invoiceportal')) {
        providerUrl = 'www.invoiceportal.gr';
      } else if (url.includes('etimologiera')) {
        providerUrl = 'www.etimologiera.gr';
      }

      printer.println(
        `${translations.printOrder.provider[lang]} ${providerUrl}`
      );
      printer.newLine();
      if (settings.poweredByQuickord) {
        printer.println(
          tr(`POWERED BY ${project.toUpperCase()}`, settings.transliterate)
        );
      }
      printer.newLine();
      printer.println(
        tr(
          `${translations.printOrder.paymentSlipEnd[lang]}`,
          settings.transliterate
        )
      );
      printer.alignCenter();
      printer.cut();

      await executePrinter(printer, printerIdentifier, 'payment slip print', {
        orderNumber,
        mark: aadeInvoice?.mark,
      });
      successCount++;
      successes.push(printerIdentifier);
    } catch (error) {
      errors.push({ printerIdentifier, error });
      if (error instanceof PrinterConnectionError) {
        logger.error(
          `Cannot print payment slip - printer ${printerIdentifier} is not connected or unreachable`
        );
      } else {
        logger.error(`Failed to print payment slip to ${printerIdentifier}:`, {
          error: error instanceof Error ? error.message : String(error),
          orderNumber,
          mark: aadeInvoice?.mark,
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
  }

  // If no printers succeeded, throw an error
  if (successCount === 0 && errors.length > 0) {
    const errorMessages = errors.map(
      (e) =>
        `${e.printerIdentifier}: ${e.error instanceof Error ? e.error.message : String(e.error)}`
    );
    throw new PrinterError(
      `Failed to print payment slip to any printer. Errors: ${errorMessages.join('; ')}`
    );
  }

  return { successes, errors };
};

const printPaymentReceipt = async (
  aadeInvoice: AadeInvoice,
  orderNumber: number,
  orderType: string,
  issuerText: string,
  discounts: any[] = [],
  tip: number,
  appId: string,
  project: string = 'centrix',
  order: any = null,
  lang: SupportedLanguages = 'el'
) => {
  let successCount = 0;
  const errors: Array<{ printerIdentifier: string; error: unknown }> = [];
  const successes: string[] = [];
  const skipped: Array<{ printerIdentifier: string; reason: string }> = [];

  for (let i = 0; i < printers.length; i += 1) {
    const settings = printers[i]?.[1];
    const printer = printers[i]?.[0];
    const printerIdentifier =
      settings?.name ||
      settings?.id ||
      settings?.ip ||
      settings?.port ||
      `printer-${i}`;

    printer?.clear();
    if (!settings || !printer) {
      skipped.push({
        printerIdentifier,
        reason: 'Printer not configured or missing settings',
      });
      continue;
    }
    if (settings.documentsToPrint !== undefined) {
      if (!settings.documentsToPrint?.includes('ALP')) {
        console.log('ALP is not in documentsToPrint');
        skipped.push({
          printerIdentifier,
          reason: 'Printer not configured to print ALP documents',
        });
        continue;
      }
    }

    console.log(appId, settings.printerType);
    if (settings.printerType === 'KIOSK' && appId !== 'kiosk') {
      console.log('skipping because its kiosk printer from desktop');
      skipped.push({
        printerIdentifier,
        reason: 'Printer is configured as KIOSK printer only',
      });
      continue;
    }
    console.log('printing ALP');
    for (let copies = 0; copies < settings.copies; copies += 1) {
      try {
        changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
        printer.alignCenter();
        printer.println(`${translations.printOrder.reciept[lang]}`);
        await venueData(printer, aadeInvoice, issuerText, settings, lang);
        receiptData(
          printer,
          aadeInvoice,
          settings,
          orderNumber,
          orderType,
          lang
        );
        const [sumAmount, sumQuantity, fixedBreakdown] = printProducts(
          printer,
          aadeInvoice,
          order,
          settings,
          lang,
          discounts
        );
        // Line 1: Left-aligned item quantity (small text)
        printer.setTextSize(0, 0);
        printDiscountAndTip(printer, discounts, tip, lang);

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
        printPayments(printer, aadeInvoice, lang);
        printVatBreakdown(printer, fixedBreakdown, lang);
        printMarks(printer, aadeInvoice, lang);
        if (settings.poweredByQuickord) {
          printer.println(
            tr(`POWERED BY ${project.toUpperCase()}`, settings.transliterate)
          );
        }
        printer.newLine();
        printer.println(
          tr(
            `${translations.printOrder.recieptEnd[lang]}`,
            settings.transliterate
          )
        );
        printer.newLine();
        printer.alignCenter();
        printer.cut();

        const printerIdentifier =
          settings?.name ||
          settings?.id ||
          settings?.ip ||
          settings?.port ||
          `printer-${i}`;

        await executePrinter(
          printer,
          printerIdentifier,
          'payment receipt print',
          {
            orderNumber,
            mark: aadeInvoice?.mark,
            copy: copies + 1,
            totalCopies: settings.copies,
          }
        );
        successCount++;
        if (copies === 0) {
          successes.push(printerIdentifier);
        }
      } catch (error) {
        const printerIdentifier =
          settings?.name ||
          settings?.id ||
          settings?.ip ||
          settings?.port ||
          `printer-${i}`;

        errors.push({ printerIdentifier, error });
        if (error instanceof PrinterConnectionError) {
          logger.error(
            `Cannot print payment receipt - printer ${printerIdentifier} is not connected or unreachable`
          );
        } else {
          logger.error(
            `Failed to print payment receipt to ${printerIdentifier}:`,
            {
              error: error instanceof Error ? error.message : String(error),
              orderNumber,
              mark: aadeInvoice?.mark,
              copy: copies + 1,
              stack: error instanceof Error ? error.stack : undefined,
            }
          );
        }
      }
    }
  }

  // If no printers succeeded and none were skipped, throw an error
  if (successCount === 0 && errors.length > 0 && skipped.length === 0) {
    const errorMessages = errors.map(
      (e) =>
        `${e.printerIdentifier}: ${e.error instanceof Error ? e.error.message : String(e.error)}`
    );
    throw new PrinterError(
      `Failed to print payment receipt to any printer. Errors: ${errorMessages.join('; ')}`
    );
  }

  return { successes, errors, skipped };
};

const printInvoice = async (
  aadeInvoice: AadeInvoice,
  orderNumber: number,
  orderType: string,
  issuerText: string,
  discounts: any[] = [],
  tip: number,
  appId: string,
  project: string = 'centrix',
  order: any = null,
  lang: SupportedLanguages = 'el'
) => {
  let successCount = 0;
  const errors: Array<{ printerIdentifier: string; error: unknown }> = [];
  const successes: string[] = [];
  const skipped: Array<{ printerIdentifier: string; reason: string }> = [];

  for (let i = 0; i < printers.length; i += 1) {
    const settings = printers[i]?.[1];
    const printer = printers[i]?.[0];
    const printerIdentifier =
      settings?.name ||
      settings?.id ||
      settings?.ip ||
      settings?.port ||
      `printer-${i}`;

    printer?.clear();
    if (!settings || !printer) {
      skipped.push({
        printerIdentifier,
        reason: 'Printer not configured or missing settings',
      });
      continue;
    }
    if (settings.documentsToPrint !== undefined) {
      if (!settings.documentsToPrint?.includes('ALP')) {
        console.log(
          'ALP is not in documentsToPrint (yes its also for invoices)'
        );
        skipped.push({
          printerIdentifier,
          reason: 'Printer not configured to print ALP documents',
        });
        continue;
      }
    }
    console.log(appId, settings.printerType);
    if (settings.printerType === 'KIOSK' && appId !== 'kiosk') {
      console.log('skipping because its kiosk printer from desktop');
      skipped.push({
        printerIdentifier,
        reason: 'Printer is configured as KIOSK printer only',
      });
      continue;
    }
    console.log('printing invoice');
    for (let copies = 0; copies < settings.copies; copies += 1) {
      console.log('print copies: ', copies);
      try {
        changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
        await venueData(printer, aadeInvoice, issuerText, settings, lang);
        printer.newLine();
        printer.println(`${translations.printOrder.customerInfo[lang]}`);
        printer.println(`${aadeInvoice?.counterpart.name}`);
        printer.println(`${aadeInvoice?.counterpart.activity}`);
        printer.println(
          `${aadeInvoice?.counterpart.address.street} ${aadeInvoice?.counterpart.address.city}, ${aadeInvoice?.counterpart.address.postal_code}`
        );
        printer.println(`${aadeInvoice?.counterpart.tax_office}`);
        printer.println(`${aadeInvoice?.counterpart.vat_number}`);
        printer.newLine();
        printer.println(`${translations.printOrder.invoice[lang]}`);
        receiptData(
          printer,
          aadeInvoice,
          settings,
          orderNumber,
          orderType,
          lang
        );
        const [sumAmount, sumQuantity, fixedBreakdown] = printProducts(
          printer,
          aadeInvoice,
          order,
          settings,
          lang,
          discounts
        );
        // Line 1: Left-aligned item quantity (small text)
        printer.setTextSize(0, 0);
        printDiscountAndTip(printer, discounts, tip, lang);
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
        printPayments(printer, aadeInvoice, lang);
        printVatBreakdown(printer, fixedBreakdown, lang);
        printMarks(printer, aadeInvoice, lang);
        printer.newLine();
        if (settings.poweredByQuickord) {
          printer.println(
            tr(`POWERED BY ${project.toUpperCase()}`, settings.transliterate)
          );
        }
        printer.newLine();
        printer.alignCenter();
        printer.cut();

        const printerIdentifier =
          settings?.name ||
          settings?.id ||
          settings?.ip ||
          settings?.port ||
          `printer-${i}`;

        await executePrinter(printer, printerIdentifier, 'invoice print', {
          orderNumber,
          mark: aadeInvoice?.mark,
          copy: copies + 1,
          totalCopies: settings.copies,
        });
        successCount++;
        if (copies === 0) {
          successes.push(printerIdentifier);
        }
      } catch (error) {
        const printerIdentifier =
          settings?.name ||
          settings?.id ||
          settings?.ip ||
          settings?.port ||
          `printer-${i}`;

        errors.push({ printerIdentifier, error });
        if (error instanceof PrinterConnectionError) {
          logger.error(
            `Cannot print invoice - printer ${printerIdentifier} is not connected or unreachable`
          );
        } else {
          logger.error(`Failed to print invoice to ${printerIdentifier}:`, {
            error: error instanceof Error ? error.message : String(error),
            orderNumber,
            mark: aadeInvoice?.mark,
            copy: copies + 1,
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      }
    }
  }

  // If no printers succeeded and none were skipped, throw an error
  if (successCount === 0 && errors.length > 0 && skipped.length === 0) {
    const errorMessages = errors.map(
      (e) =>
        `${e.printerIdentifier}: ${e.error instanceof Error ? e.error.message : String(e.error)}`
    );
    throw new PrinterError(
      `Failed to print invoice to any printer. Errors: ${errorMessages.join('; ')}`
    );
  }

  return { successes, errors, skipped };
};

const printMyPelatesReceipt = async (
  aadeInvoice: AadeInvoice,
  issuerText: string,
  lang: SupportedLanguages = 'el'
) => {
  let successCount = 0;
  const errors: Array<{ printerIdentifier: string; error: unknown }> = [];
  const successes: string[] = [];
  const skipped: Array<{ printerIdentifier: string; reason: string }> = [];

  for (let i = 0; i < printers.length; i += 1) {
    const settings = printers[i]?.[1];
    const printer = printers[i]?.[0];
    const printerIdentifier =
      settings?.name ||
      settings?.id ||
      settings?.ip ||
      settings?.port ||
      `printer-${i}`;

    printer?.clear();
    if (!settings || !printer) {
      skipped.push({
        printerIdentifier,
        reason: 'Printer not configured or missing settings',
      });
      continue;
    }
    if (settings.documentsToPrint !== undefined) {
      if (!settings.documentsToPrint?.includes('ALP')) {
        console.log('ALP is not in documentsToPrint');
        skipped.push({
          printerIdentifier,
          reason: 'Printer not configured to print ALP documents',
        });
        continue;
      }
    }
    for (let copies = 0; copies < settings.copies; copies += 1) {
      console.log('print copies: ', copies);
      try {
        changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
        printer.alignCenter();
        printer.println(`${translations.printOrder.reciept[lang]}`);
        await venueData(printer, aadeInvoice, issuerText, settings, lang);
        receiptData(printer, aadeInvoice, settings, 0, 'MYPELATES', lang);
        printer.alignLeft();

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

          const name = detail.name.toUpperCase();
          const quantity = detail.quantity.toFixed(0); // "1,000"
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
        printPayments(printer, aadeInvoice, lang);
        printMarks(printer, aadeInvoice, lang);
        printer.newLine();
        if (settings.poweredByQuickord) {
          printer.println(tr(`POWERED BY MYPELATES`, settings.transliterate));
        }
        printer.newLine();
        printer.println(
          tr(
            `${translations.printOrder.recieptEnd[lang]}`,
            settings.transliterate
          )
        );
        printer.newLine();
        printer.alignCenter();
        printer.cut();

        const printerIdentifier =
          settings?.name ||
          settings?.id ||
          settings?.ip ||
          settings?.port ||
          `printer-${i}`;

        await executePrinter(
          printer,
          printerIdentifier,
          'MyPelates receipt print',
          {
            mark: aadeInvoice?.mark,
            copy: copies + 1,
            totalCopies: settings.copies,
          }
        );
        successCount++;
        if (copies === 0) {
          successes.push(printerIdentifier);
        }
      } catch (error) {
        const printerIdentifier =
          settings?.name ||
          settings?.id ||
          settings?.ip ||
          settings?.port ||
          `printer-${i}`;

        errors.push({ printerIdentifier, error });
        if (error instanceof PrinterConnectionError) {
          logger.error(
            `Cannot print MyPelates receipt - printer ${printerIdentifier} is not connected or unreachable`
          );
        } else {
          logger.error(
            `Failed to print MyPelates receipt to ${printerIdentifier}:`,
            {
              error: error instanceof Error ? error.message : String(error),
              mark: aadeInvoice?.mark,
              copy: copies + 1,
              stack: error instanceof Error ? error.stack : undefined,
            }
          );
        }
      }
    }
  }

  // If no printers succeeded and none were skipped, throw an error
  if (successCount === 0 && errors.length > 0 && skipped.length === 0) {
    const errorMessages = errors.map(
      (e) =>
        `${e.printerIdentifier}: ${e.error instanceof Error ? e.error.message : String(e.error)}`
    );
    throw new PrinterError(
      `Failed to print MyPelates receipt to any printer. Errors: ${errorMessages.join('; ')}`
    );
  }

  return { successes, errors, skipped };
};

const printMyPelatesInvoice = async (
  aadeInvoice: AadeInvoice,
  issuerText: string,
  lang: SupportedLanguages = 'el'
) => {
  let successCount = 0;
  const errors: Array<{ printerIdentifier: string; error: unknown }> = [];
  const successes: string[] = [];
  const skipped: Array<{ printerIdentifier: string; reason: string }> = [];

  for (let i = 0; i < printers.length; i += 1) {
    const settings = printers[i]?.[1];
    const printer = printers[i]?.[0];
    const printerIdentifier =
      settings?.name ||
      settings?.id ||
      settings?.ip ||
      settings?.port ||
      `printer-${i}`;

    printer?.clear();
    if (!settings || !printer) {
      skipped.push({
        printerIdentifier,
        reason: 'Printer not configured or missing settings',
      });
      continue;
    }
    if (settings.documentsToPrint !== undefined) {
      if (!settings.documentsToPrint?.includes('ALP')) {
        console.log('ALP is not in documentsToPrint');
        skipped.push({
          printerIdentifier,
          reason: 'Printer not configured to print ALP documents',
        });
        continue;
      }
    }
    for (let copies = 0; copies < settings.copies; copies += 1) {
      console.log('print copies: ', copies);
      try {
        changeCodePage(printer, settings?.codePage || DEFAULT_CODE_PAGE);
        printer.alignCenter();
        await venueData(printer, aadeInvoice, issuerText, settings, lang);
        printer.newLine();
        printer.println(`${translations.printOrder.customerInfo[lang]}`);
        printer.println(`${aadeInvoice?.counterpart.name}`);
        printer.println(`${aadeInvoice?.counterpart.activity}`);
        printer.println(
          `${aadeInvoice?.counterpart.address.street} ${aadeInvoice?.counterpart.address.city}, ${aadeInvoice?.counterpart.address.postal_code}`
        );
        printer.println(`${aadeInvoice?.counterpart.tax_office}`);
        printer.println(`${aadeInvoice?.counterpart.vat_number}`);
        printer.newLine();
        printer.println(`${translations.printOrder.invoice[lang]}`);
        receiptData(printer, aadeInvoice, settings, 0, 'MYPELATES', lang);
        printer.alignLeft();

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

          const name = detail.name.toUpperCase();
          const quantity = detail.quantity.toFixed(0); // "1,000"
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
        printPayments(printer, aadeInvoice, lang);
        printMarks(printer, aadeInvoice, lang);
        printer.newLine();
        if (settings.poweredByQuickord) {
          printer.println(tr(`POWERED BY MYPELATES`, settings.transliterate));
        }
        printer.newLine();
        printer.alignCenter();
        printer.cut();

        await executePrinter(
          printer,
          printerIdentifier,
          'MyPelates invoice print',
          {
            mark: aadeInvoice?.mark,
            copy: copies + 1,
            totalCopies: settings.copies,
          }
        );
        successCount++;
        successes.push(printerIdentifier);
      } catch (error) {
        errors.push({ printerIdentifier, error });
        if (error instanceof PrinterConnectionError) {
          logger.error(
            `Cannot print MyPelates invoice - printer ${printerIdentifier} is not connected or unreachable`
          );
        } else {
          logger.error(
            `Failed to print MyPelates invoice to ${printerIdentifier}:`,
            {
              error: error instanceof Error ? error.message : String(error),
              mark: aadeInvoice?.mark,
              copy: copies + 1,
              stack: error instanceof Error ? error.stack : undefined,
            }
          );
        }
      }
    }
  }

  // If no printers succeeded and none were skipped, throw an error
  if (successCount === 0 && errors.length > 0 && skipped.length === 0) {
    const errorMessages = errors.map(
      (e) =>
        `${e.printerIdentifier}: ${e.error instanceof Error ? e.error.message : String(e.error)}`
    );
    throw new PrinterError(
      `Failed to print MyPelates invoice to any printer. Errors: ${errorMessages.join('; ')}`
    );
  }

  return { successes, errors, skipped };
};

export const printOrder = async (
  order: z.infer<typeof Order>,
  appId: string = 'desktop',
  project: string = 'centrix',
  lang: SupportedLanguages = 'el'
) => {
  const successes: string[] = [];
  const errors: Array<{ printerIdentifier: string; error: unknown }> = [];
  const skipped: Array<{ printerIdentifier: string; reason: string }> = [];

  for (let i = 0; i < printers.length; i += 1) {
    let dontPrint = false;
    const settings = printers[i]?.[1];
    const printer = printers[i]?.[0];
    const printerIdentifier =
      settings?.name ||
      settings?.id ||
      settings?.ip ||
      settings?.port ||
      `printer-${i}`;

    try {
      printer?.clear();
      if (!settings || !printer) {
        printer?.clear();
        skipped.push({
          printerIdentifier,
          reason: 'Printer not configured or missing settings',
        });
        continue;
      }
      if (settings.orderMethodsToPrint !== undefined) {
        if (!settings.orderMethodsToPrint?.includes(order.orderType)) {
          console.log(
            `orderType ${order.orderType} is not in orderMethodsToPrint`
          );
          skipped.push({
            printerIdentifier,
            reason: `Order method ${order.orderType} not in printer's orderMethodsToPrint configuration`,
          });
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

        // Find which categories caused the filtering
        if (
          settings.categoriesToPrint !== undefined &&
          order.orderType !== 'EFOOD'
        ) {
          const orderCategories = Array.from(
            new Set(order.products.flatMap((product) => product.categories))
          );

          const missingCategories = orderCategories.filter(
            (category) => !settings.categoriesToPrint?.includes(category)
          );

          if (missingCategories.length > 0) {
            console.log(
              'No products match printer categoriesToPrint',
              missingCategories
            );
            skipped.push({
              printerIdentifier,
              reason: `No products match printer's categories to print. Missing categories: ${missingCategories.join(', ')}`,
            });
            continue;
          }
        }

        skipped.push({
          printerIdentifier,
          reason: "No products match printer's categories to print",
        });
        continue;
      }
      if (settings.documentsToPrint !== undefined) {
        if (!settings.documentsToPrint?.includes('ORDER')) {
          console.log('ORDER is not in documentsToPrint');
          skipped.push({
            printerIdentifier,
            reason: 'Printer not configured to print ORDER documents',
          });
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
        printer.println(
          tr(normalizeGreek(order.venue.title), settings.transliterate)
        );
        printer.println(
          tr(normalizeGreek(order.venue.address), settings.transliterate)
        );
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
            printer.bold(true);
            printer.table([
              tr(
                `${translations.printOrder.tableNumber[lang]}:${order.tableNumber}`,
                settings.transliterate
              ),
              ...(order.waiterName
                ? [
                    tr(
                      `${translations.printOrder.waiter[lang]}:${normalizeGreek(order.waiterName)}`,
                      settings.transliterate
                    ),
                  ]
                : []),
            ]);
            printer.bold(false);
          }
        }
        printer.bold(true);
        printer.print(
          tr(
            `${translations.printOrder.orderType[lang]}:`,
            settings.transliterate
          )
        );
        printer.bold(false);
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
        changeTextSize(printer, settings?.textSize || 'NORMAL');

        drawLine2(printer);

        if (order.deliveryInfo) {
          printer.println(
            tr(
              `${translations.printOrder.customerName[lang]}:${normalizeGreek(order.deliveryInfo.customerFirstname || '')} ${normalizeGreek(order.deliveryInfo.customerLastname || '')}`,
              settings.transliterate
            )
          );
          printer.println(
            tr(
              `${translations.printOrder.deliveryAddress[lang]}:${normalizeGreek(order.deliveryInfo.customerAddress)}`,
              settings.transliterate
            )
          );
          printer.println(
            tr(
              `${translations.printOrder.deliveryFloor[lang]}:${normalizeGreek(order.deliveryInfo.customerFloor)}`,
              settings.transliterate
            )
          );
          printer.println(
            tr(
              `${translations.printOrder.deliveryBell[lang]}:${normalizeGreek(order.deliveryInfo.customerBell)}`,
              settings.transliterate
            )
          );
          printer.println(
            tr(
              `${translations.printOrder.deliveryPhone[lang]}:${order.deliveryInfo.customerPhoneNumber}`,
              settings.transliterate
            )
          );
          if (settings.startOrder) {
            drawLine2(printer);
          }
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
                `${translations.printOrder.customerName[lang]}:${normalizeGreek(order.TakeAwayInfo.customerName || '')}`,
                settings.transliterate
              )
            );
            drawLine = true;
          }

          if (order.TakeAwayInfo.customerEmail) {
            printer.println(
              tr(
                `${translations.printOrder.customerEmail[lang]}:${normalizeGreek(order.TakeAwayInfo.customerEmail)}`,
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
        if (settings.startOrder) {
          printer.println(
            tr(
              `${translations.printOrder.startOrder[lang]}`,
              settings.transliterate
            )
          );
          drawLine2(printer);
        }
        printer.alignLeft();

        productsToPrint.forEach((product) => {
          let total = product.total || 0;
          const leftAmount = `${product.quantity}x `.length;
          console.log(order.appId, settings.printerType);
          console.log(
            'cond',
            order.appId !== 'kiosk' && settings.printerType === 'KIOSK'
          );
          if (order.appId !== 'kiosk' && settings.printerType === 'KIOSK') {
            dontPrint = true;
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
          let productLine = `${product.quantity}x ${normalizeGreek(product.title)}`;
          if (
            product.updateStatus?.includes('NEW') &&
            isEdit &&
            product.quantityChanged
          ) {
            productLine = `${product.quantity}x ${normalizeGreek(product.title)}`;
          } else if (isEdit && product.quantityChanged) {
            productLine = `${product.quantityChanged.was} -> ${product.quantity}x ${normalizeGreek(product.title)}`;
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
            const amountLevel =
              choice.amountLevel != null &&
              translations.printOrder.amountLevel?.[lang]
                ? (translations.printOrder.amountLevel[lang][
                    choice.amountLevel as any
                  ] ?? '')
                : '';

            const choiceLine = `- ${amountLevel} ${Number(choice.quantity) > 1 ? `${choice.quantity}x ` : ''}${normalizeGreek(choice.title)}`;

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
                ` ${translations.printOrder.productComments[lang]}: ${normalizeGreek(product.comments.toUpperCase())}`,
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
                choicesTotal += (choice.price || 0) * (choice.quantity || 1);
              });
            }

            const rawTotal = product.quantity * (product.total + choicesTotal);
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
                `${convertToDecimal(total * product.quantity).toFixed(2)} €`,
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
        if (settings.poweredByQuickord) {
          printer.println(
            tr(`POWERED BY ${project.toUpperCase()}`, settings.transliterate)
          );
        }
        printer.newLine();
        printer.newLine();
        printer.alignCenter();
        printer.println(`${translations.printOrder.notReceiptNotice[lang]}`);
        printer.println(
          `${translations.printOrder.notReceiptNoticeContinue[lang]}`
        );
        printer.cut();
      }

      if (!dontPrint) {
        try {
          await executePrinter(printer, printerIdentifier, 'order print', {
            orderId: order._id,
            orderNumber: order.number,
            orderType: order.orderType,
          });
          successes.push(printerIdentifier);
        } catch (execError) {
          if (execError instanceof PrinterConnectionError) {
            logger.error(
              `Cannot print order - printer ${printerIdentifier} is not connected or unreachable`
            );
            errors.push({ printerIdentifier, error: execError });
          } else {
            logger.error(`Failed to print order to ${printerIdentifier}:`, {
              error:
                execError instanceof Error
                  ? execError.message
                  : String(execError),
              orderId: order._id,
              orderNumber: order.number,
              stack: execError instanceof Error ? execError.stack : undefined,
            });
            errors.push({ printerIdentifier, error: execError });
          }
        }
      }
    } catch (error) {
      logger.error(`Error preparing order print for ${printerIdentifier}:`, {
        error: error instanceof Error ? error.message : String(error),
        orderId: order._id,
        orderNumber: order.number,
        stack: error instanceof Error ? error.stack : undefined,
      });
      errors.push({ printerIdentifier, error });
    }
  }

  return { successes, errors, skipped };
};

export const printOrders = async (orders: z.infer<typeof Order>[]) => {
  const allSuccesses: string[] = [];
  const allErrors: Array<{ printerIdentifier: string; error: unknown }> = [];
  const allSkipped: Array<{ printerIdentifier: string; reason: string }> = [];

  for (const order of orders) {
    const result = await printOrder(order);
    allSuccesses.push(...result.successes);
    allErrors.push(...result.errors);
    allSkipped.push(...result.skipped);
  }

  return { successes: allSuccesses, errors: allErrors, skipped: allSkipped };
};
