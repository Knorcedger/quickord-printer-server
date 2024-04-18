import express from 'express';

import homepage from './homepage';
import logger from './modules/logger';
import { initNetWorkScanner, scanNetworkForPrinters } from './modules/network';
import { getSettings, loadSettings } from './modules/settings';
import printOrdersResolver from './printOrdersResolver';
import settingsResolver from './settingsResolver';

const main = async () => {
  const SERVER_PORT = 7810;

  logger.init();

  await initNetWorkScanner();

  await loadSettings();

  const app = express();

  app.route('/').get((req, res) => {
    res.send(homepage());
  });

  app
    .route('/settings')
    .post(express.json({ type: 'application/json' }), settingsResolver)
    .get((req, res) => {
      res.status(200).send(getSettings());
    });

  app.route('/status').get((req, res) => {
    res.status(200).send({ status: 'ok' });
  });

  app.route('/network').get(async (req, res) => {
    res.status(200).send({ printers: await scanNetworkForPrinters() });
  });

  app
    .route('/print-orders')
    .post(express.json({ type: 'application/json' }), printOrdersResolver);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const errorMessage = `Problem: Unhandled error detected. Message: ${err.message}. URL: ${req.url}.`;

    logger.error(errorMessage);

    let status = 500;

    if (err.message === 'invalidGraphqlQuery') {
      status = 400;
    }

    res.status(status).send(`{"errors":[{"message":"${err.message}"}]}`);
  });

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
process.on('uncaughtException', (err) => {
  logger.error('Problem: uncaughtException', err);
});

process.on('unhandledRejection', (reason, p) => {
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
