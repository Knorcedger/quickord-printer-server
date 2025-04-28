import * as bodyParser from 'body-parser';
const cors = require('cors');

import * as nconf from 'nconf';
import { exit, env } from 'node:process';
import { CharacterSet } from 'node-thermal-printer';

const express = require('express');
import { Request, Response } from 'express';

import { homepage } from './homepage';
import logger from './modules/logger';
import { initModem } from './modules/modem';
import scanNetworkForConnections from './modules/network';
import { setupPrinters, paymentReceipt } from './modules/printer';
import {
  getSettings,
  loadSettings,
  PrinterTextOptions,
  PrinterTextSize,
} from './modules/settings';
import printOrders from './resolvers/printOrders';
import settings from './resolvers/settings';
import testPrint from './resolvers/testPrint';
import * as autoUpdate from './autoupdate/autoupdate';

const main = async () => {
  const SERVER_PORT = nconf.get('PORT') || 7810;

  await logger.init();
  const args = process.argv.slice(2); // Get arguments after the script name
  console.log('Arguments:', args);

  let updatePath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--update' && i + 1 < args.length) {
      updatePath = args[i + 1] ?? null; // Get the next argument as the update path
    }
  }

  console.log('Update path:', args);

  //await autoUpdate(args || ''); // Ensure updatePath is a string
  // await scanNetworkForConnections();

  await loadSettings();

  await initModem();

  await setupPrinters(getSettings());

  const app = express();
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

  app
    .route('/status')
    .get((req: Request<{}, any, any>, res: Response<{}, any>) => {
      res.status(200).send({ status: 'ok' });
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

  app.route('/print-orders').post(printOrders);
  app.route('/print-payment-receipt').post(paymentReceipt);

  app.route('/test-print').post(testPrint);

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
  const server = app.listen(SERVER_PORT, () => {
    logger.info(
      'API listening at port',
      (server?.address?.() as { port: number })?.port
    );
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
