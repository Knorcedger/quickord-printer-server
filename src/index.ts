import express from 'express';
import nconf from 'nconf';
import signale from 'signale';

nconf.argv().env().file('./config.json');

const app = express();

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const errorMessage = `Problem: Unhandled error detected. Details saved in db.
  Message: ${err.message}. URL: ${req.url}.
  Info: ${req.getInfo()}`;

  signale.error(errorMessage);

  let status = 500;

  if (err.message === 'invalidGraphqlQuery') {
    status = 400;
  }

  res.status(status).send(`{"errors":[{"message":"${err.message}"}]}`);
});

// start server
const server = app.listen(nconf.get('PORT'), () => {
  signale.info(
    'API listening at port',
    (server?.address?.() as { port: number })?.port
  );
});

const skipErrorNames = ['ValidationError'];

// catch any uncaught exceptions, so that the server never crashes
process.on('uncaughtException', (err) => {
  signale.error('Problem: uncaughtException', err);
});

process.on('unhandledRejection', (reason, p) => {
  if (skipErrorNames.includes((reason as Error).name)) {
    return;
  }

  signale.error(
    'Problem: Unhandled Rejection at: Promise',
    p,
    'reason:',
    reason
  );
});
