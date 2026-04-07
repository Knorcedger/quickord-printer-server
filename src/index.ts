import * as bodyParser from 'body-parser';
import cors from 'cors';
import nconf from 'nconf';
import { CharacterSet } from 'node-thermal-printer';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { Request, Response } from 'express';
import { homepage } from './homepage';
import logger from './modules/logger';
import { initModem } from './modules/modem';
import scanNetworkForConnections from './modules/network';
import {
  setupPrinters,
  paymentReceipt,
  invoice,
  invoiceMyPelates,
} from './modules/printer';
import { printText } from './modules/printer';
import {
  getSettings,
  loadSettings,
  PrinterTextOptions,
  PrinterTextSize,
} from './modules/settings';
import { dedup } from './modules/dedup';
import printOrders from './resolvers/printOrders';
import { paymentSlip } from './modules/printer';
import { deliveryNote } from './modules/printer';
import { parkingTicket } from './modules/printer';
import { orderForm } from './modules/printer';
import { checkPrinters } from './modules/printer';
import { pelatologioRecord } from './modules/printer';
import settings from './resolvers/settings';
import testPrint from './resolvers/testPrint';
import autoUpdate from './autoupdate/autoupdate';
import { apiCall, getLocalIP } from './modules/api';
import { paymentMyPelatesReceipt } from './modules/printer';
import { execSync } from 'child_process';

const main = async () => {
  const SERVER_PORT =
    nconf.argv().env().file({ file: './config.json' }).get('PORT') || 7810;

  await logger.init();
  const args = process.argv.slice(2); // Get arguments after the script name
  if (args[0] !== '--noupdate') {
    console.log('Arguments:', args);
    let updatePath: string | null = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--update' && i + 1 < args.length) {
        updatePath = args[i + 1] ?? null; // Get the next argument as the update path
      }
    }

    console.log('Update path:', process.argv);
    await autoUpdate(args); // Ensure updatePath is a string
  }

  await loadSettings();

  try {
    await initModem();
  } catch (err) {
    logger.error('Failed to initialize modem, continuing without modem:', err);
  }

  await setupPrinters(getSettings());

  const app = express();
  let server!: ReturnType<typeof app.listen>;
  app.use(
    cors({
      origin(origin: string | undefined, callback: any) {
        if (
          !origin?.includes('quickord.com') &&
          !origin?.includes('localhost') &&
          !origin?.includes('quickord-waiter-dev.vercel.app')
        ) {
          logger.info('cors origin:', origin);
        }

        callback(null, true);
      },
    })
  );

  app.use(bodyParser.json());

  app.route('/').get((req: Request<{}, any, any>, res: Response<{}, any>) => {
    res.send(homepage());
  });

  app
    .route('/settings')
    .post(settings)
    .get((req: Request<{}, any, any>, res: Response<{}, any>) => {
      res.status(200).send(getSettings());
    });

  function getPrinterVersion(): string {
    const versionFilePath = path.join(__dirname, '../version');
    try {
      const version = fs.readFileSync(versionFilePath, 'utf-8').trim();
      return version;
    } catch (error) {
      console.error('Error reading version file:', error);
      return 'unknown';
    }
  }

  // Simple HTTPS request (works inside exe)

  async function fetchLatestVersion() {
    try {
      const cmd = `curl -s -L https://api.github.com/repos/Knorcedger/quickord-printer-server/releases/latest`;
      const output = execSync(cmd, { encoding: 'utf-8' });
      const json = JSON.parse(output);
      return json.name || json.tag_name || 'unknown';
    } catch (err) {
      console.error('curl failed:', err);
      return 'unknown';
    }
  }

  // ------------------ ROUTES ------------------

  app
    .route('/printer-version')
    .post(settings)
    .get((req: Request, res: Response) => {
      const version = getPrinterVersion();
      res.status(200).json({ version });
    });

  app.get('/request-latest-version', async (req, res) => {
    try {
      const version = await fetchLatestVersion();
      res.status(200).json({ version });
    } catch (err) {
      console.error('Error fetching version:', err);
      res.status(500).json({ version: 'unknown' });
    }
  });

  app
    .route('/status')
    .get((req: Request<{}, any, any>, res: Response<{}, any>) => {
      res.status(200).send({ status: 'ok' });
    });

  app.post('/restart', (req: Request, res: Response) => {
    res.status(200).send({ status: 'restarting' });
    setTimeout(() => {
      const isDev = process.argv[1]?.endsWith('.ts');
      if (isDev) {
        process.exit(0);
      }
      // Production: close server to release port, then spawn new process
      server.close(() => {
        const { spawn } =
          require('child_process') as typeof import('child_process');
        const child = spawn(
          process.execPath,
          [...process.execArgv, ...process.argv.slice(1)],
          {
            detached: true,
            stdio: 'ignore',
            cwd: process.cwd(),
            env: process.env,
          }
        );
        child.unref();
        process.exit(0);
      });
    }, 500);
  });

  app
    .route('/local-ip')
    .get((req: Request<{}, any, any>, res: Response<{}, any>) => {
      const localIP = getLocalIP();
      res.status(200).send({ localIP });
    });
  app.route('/available').get(async (req: Request, res: Response) => {
    try {
      const printers = await checkPrinters();
      res.status(200).send({ printers });
    } catch (error) {
      res.status(500).send({ error: 'Failed to check printers' });
    }
  });

  app
    .route('/network')
    .get(async (req: Request<{}, any, any>, res: Response<{}, any>) => {
      try {
        const lanConnections = await scanNetworkForConnections();

        res.status(200).send({ lanConnections });
      } catch (error) {
        logger.error('Error scanning network connections:', error);
        res.status(500).send({ error: 'Failed to scan network connections' });
      }
    });

  app.route('/print-orders').post(dedup, printOrders);

  app.route('/test-print').post(testPrint);
  app.route('/print-alp').post(dedup, paymentReceipt);
  app.route('/print-alp-mypelates').post(dedup, paymentMyPelatesReceipt);
  app.route('/print-invoice-mypelates').post(dedup, invoiceMyPelates);

  app.route('/print-payment-slip').post(dedup, paymentSlip);
  app.route('/print-order-form').post(dedup, orderForm);
  app.route('/print-parking-ticket').post(dedup, parkingTicket);
  app.route('/print-pelatologio-record').post(dedup, pelatologioRecord);
  app.route('/print-text').post(dedup, printText);
  app.route('/print-invoice').post(dedup, invoice);
  app.route('/print-delivery-note').post(dedup, deliveryNote);

  app
    .route('/logs')
    .get((req: Request<{}, any, any>, res: Response<{}, any>) => {
      try {
        const zip = logger.createZip();

        res.status(200).setHeader('Content-Type', 'application/zip').send(zip);
      } catch (error) {
        res.status(500).send({ error });
      }
    });

  app
    .route('/get-data')
    .get((req: Request<{}, any, any>, res: Response<{}, any>) => {
      res.status(200).send({
        charset: Object.values(CharacterSet),
        textOptions: Object.values(PrinterTextOptions.Values),
        textSize: Object.values(PrinterTextSize.Values),
      });
    });

  // eslint-disable-next-line no-unused-vars
  app.use(
    (
      err: Error,
      req: Request<{}, any, any>,
      res: Response<{}, any>,
      // eslint-disable-next-line no-unused-vars
      next: any
    ) => {
      const errorMessage = `Problem: Unhandled error detected. Message: ${err.message}. URL: ${req.url}.`;

      logger.error(errorMessage);

      let status = 500;

      if (err.message === 'invalidGraphqlQuery') {
        status = 400;
      }

      res.status(status).send(`{"errors":[{"message":"${err.message}"}]}`);
    }
  );

  // start server
  server = app.listen(SERVER_PORT, () => {
    logger.info(
      'API listening at port',
      (server?.address?.() as { port: number })?.port
    );

    // Self-register printer server IP with the backend
    const venueId = getSettings().venueId || getSettings().modem?.venueId;

    if (venueId) {
      const localIp = getLocalIP();
      logger.info(
        `Registering printer server IP: ${localIp} for venue: ${venueId}`
      );
      apiCall(
        `mutation { updatePrinterServerIp(venueId: "${venueId}", ip: "${localIp}") { status ip } }`
      )
        .then((res) => {
          if (res?.errors) {
            logger.error(
              'Failed to register printer server IP:',
              JSON.stringify(res.errors)
            );
          } else if (res?.data?.updatePrinterServerIp?.status === 'ok') {
            logger.info('Printer server IP registered successfully');
          }
        })
        .catch((err) => {
          logger.error('Failed to register printer server IP:', err);
        });
    } else {
      logger.info(
        'No venueId configured, skipping printer server IP registration'
      );
    }
  });
};

const skipErrorNames: string[] = [];

// catch any uncaught exceptions, so that the server never crashes
process.on('uncaughtException', (err: Error) => {
  logger.error('Problem: uncaughtException', err);
});

process.on('unhandledRejection', (reason: unknown, p: Promise<unknown>) => {
  if (skipErrorNames.includes((reason as Error).name)) {
    return;
  }

  logger.error(
    'Problem: Unhandled Rejection at: Promise',
    p,
    'reason:',
    reason
  );
});

main();
