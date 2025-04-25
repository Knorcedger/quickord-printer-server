import bodyParser from 'body-parser';
import cors from 'cors';
import express, { Request, Response } from 'express';
import nconf from 'nconf';
import process from 'node:process';
import { CharacterSet } from 'node-thermal-printer';

import homepage from './homepage.ts';
import logger from './modules/logger.ts';
import { initModem } from './modules/modem.ts';
import { paymentReceipt, setupPrinters,orderForm, paymentSlip } from './modules/printer.ts';
import {
  getSettings,
  loadSettings,
  PrinterTextOptions,
  PrinterTextSize,
} from './modules/settings.ts';
import scanNetworkForConnections from './modules/network.ts';
import printOrders from './resolvers/printOrders.ts';
import settings from './resolvers/settings.ts';
import testPrint from './resolvers/testPrint.ts';

nconf.argv().env().file('./config.json');

const main = async () => {
  const SERVER_PORT = nconf.get('PORT') || 7810;

  await logger.init();

  //await initNetWorkScanner();

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
        res.status(500).send({ error });
      }
    });

  app.route('/print-orders').post(printOrders);

  app.route('/test-print').post(testPrint);
  app.route('/print-alp').post(paymentReceipt);

  app.route('/print-payment-slip').post(paymentSlip );
  app.route('/print-order-form').post(orderForm);
  // app.route('/modem-reset').get();
  // app.route('/modem-status').get();

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
