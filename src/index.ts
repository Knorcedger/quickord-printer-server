import bodyParser from 'body-parser';
import cors from 'cors';
import express, { Request, Response } from 'express';
import process from 'node:process';

import homepage from './homepage.ts';
import logger from './modules/logger.ts';
import {
  initNetWorkScanner,
  scanNetworkForConnections,
} from './modules/network.ts';
import { testOrderPrint } from './modules/printer.ts';
import { getSettings, loadSettings } from './modules/settings.ts';
import printOrders from './resolvers/printOrders.ts';
import settings from './resolvers/settings.ts';
import testPrint from './resolvers/testPrint.ts';

const main = async () => {
  const SERVER_PORT = 7810;

  await logger.init();

  await initNetWorkScanner();

  await loadSettings();

  const app = express();

  app.use(
    cors({
      origin(origin: string | undefined, callback: any) {
        logger.info('cors origin:', origin);

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

  app
    .route('/test')
    .get(async (req: Request<{}, any, any>, res: Response<{}, any>) => {
      await testOrderPrint('192.168.178.42', {
        TakeAwayInfo: {
          customerEmail: 'email',
          customerName: 'name',
        },
        _id: 'ssss',
        createdAt: new Date().toISOString(),
        currency: '$',
        customerComment: 'customer comment',
        deliveryInfo: {
          customerAddress: 'MITROPOLEOS 55 52100 KASTORIA',
          customerBell: 'bell',
          customerEmail: 'email',
          customerFloor: 'floor',
          customerName: 'name',
          customerPhoneNumber: 'phone',
          deliveryFee: 100,
        },
        number: 1,
        orderType: 'DELIVERY',
        paymentType: 'ONLINE',
        products: [
          {
            _id: '1234',
            categories: ['category'],
            choices: [
              {
                quantity: 1,
                title: 'choice',
              },
            ],
            quantity: 1,
            title: 'product',
            total: 1000,
          },
        ],
        tableNumber: '1',
        tip: 500,
        total: 1600,
        venue: {
          address: 'MITROPOLEOS 55 52100 KASTORIA',
          title: 'KASTORIA CITY HOTEL',
        },
        waiterComment: 'waiter comment',
      });
      res.status(200).send('test');
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
