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

        if (
          !origin ||
          origin.includes('localhost') ||
          origin.includes('quickord.com')
        ) {
          callback(null, true);
        } else {
          logger.info('cors error, origin: ', origin);
          callback(new Error('Not allowed by CORS'));
        }
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
        const connections = await scanNetworkForConnections();

        res.status(200).send({ connections });
      } catch (error) {
        res.status(500).send({ error });
      }
    });

  app.route('/print-orders').post(printOrders);

  app.route('/test-print').post(testPrint);

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
