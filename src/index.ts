import * as bodyParser from 'body-parser';
import cors from 'cors';
import nconf from 'nconf';
import { CharacterSet } from 'node-thermal-printer';
import fs from 'fs';
import os from 'os';
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
  getModems,
  getPublicSettings,
  getSettings,
  loadSettings,
  PrinterTextOptions,
  PrinterTextSize,
} from './modules/settings';
import { dedup } from './modules/dedup';
import printOrderComments from './resolvers/printOrderComments';
import printOrders, { printFullOrders } from './resolvers/printOrders';
import { paymentSlip } from './modules/printer';
import { deliveryNote } from './modules/printer';
import { parkingTicket } from './modules/printer';
import { orderForm } from './modules/printer';
import { checkPrinters } from './modules/printer';
import { pelatologioRecord } from './modules/printer';
import settings from './resolvers/settings';
import testPrint from './resolvers/testPrint';
import autoUpdate, {
  downloadLatestCode,
  isServiceManaged,
  killPortHolders,
  scheduleServiceStartWatchdog,
  setUpdateHandler,
  sweepTempUpdateDirs,
} from './autoupdate/autoupdate';
import { getLocalIP, registerPrinterServerIp } from './modules/api';
import {
  curlExecJson,
  httpStatusError,
  tryFetchWithFallback,
} from './modules/http';
import { paymentMyPelatesReceipt } from './modules/printer';
import { initPullClient } from './modules/pullClient';
import { setRestartHandler } from './modules/psIdentity';

// A bind failure repeats on every restart until whatever holds the port is
// gone, so the recovery has to converge: clear the port, and stop scheduling
// watchdogs after a few attempts instead of spawning one every ~15s forever.
// The counter outlives the process, so it lives in a temp file.
const BIND_FAILURE_STATE = path.join(os.tmpdir(), 'quickord-bind-failures.json');
const BIND_FAILURE_WINDOW_MS = 15 * 60_000;
const BIND_FAILURE_MAX = 5;

function recordBindFailure(): number {
  const now = Date.now();
  let first = now;
  let count = 0;
  try {
    const prev = JSON.parse(fs.readFileSync(BIND_FAILURE_STATE, 'utf-8'));
    if (
      typeof prev.first === 'number' &&
      now - prev.first < BIND_FAILURE_WINDOW_MS
    ) {
      first = prev.first;
      count = typeof prev.count === 'number' ? prev.count : 0;
    }
  } catch {
    // no usable history: this is the first failure of the window
  }
  count += 1;
  try {
    fs.writeFileSync(BIND_FAILURE_STATE, JSON.stringify({ count, first }));
  } catch {
    // best effort — a lost counter only costs one more retry
  }
  return count;
}

async function handleBindFailure(
  err: NodeJS.ErrnoException,
  port: number
): Promise<void> {
  const attempt = recordBindFailure();
  logger.error(
    `Problem: failed to bind port ${port} (${err.code}), attempt ${attempt}. Exiting so the service manager retries.`
  );

  // Exiting alone never frees the port, so the orphan holding it would outlive
  // every restart. Kill it here and the next boot binds cleanly.
  if (err.code === 'EADDRINUSE') {
    try {
      const killed = await killPortHolders(port);
      if (killed.length) {
        logger.info(`Killed PID(s) ${killed.join(', ')} holding port ${port}.`);
      }
    } catch (e) {
      logger.error('Failed to clear the port:', e);
    }
  }

  // The exit code only restarts us where the failure actions are configured, so
  // schedule the watchdog too: it covers venues still on the old service config
  // and orphaned instances, which have nobody watching them.
  if (attempt < BIND_FAILURE_MAX) {
    scheduleServiceStartWatchdog();
  } else {
    logger.error(
      `Problem: port ${port} still unusable after ${attempt} attempts; leaving the restart to the service manager.`
    );
  }
  process.exit(1);
}

const main = async () => {
  const SERVER_PORT =
    nconf.argv().env().file({ file: './config.json' }).get('PORT') || 7810;

  await logger.init();
  const args = process.argv.slice(2); // Get arguments after the script name
  if (args[0] !== '--noupdate') {
    console.log('Arguments:', args);

    // Clear out the temp trees left by previous updates. Done before the
    // version check so a failed update never accumulates copies of the build.
    try {
      await sweepTempUpdateDirs();
    } catch (err) {
      logger.error('Failed to sweep temp update folders:', err);
    }

    console.log('Update path:', process.argv);
    // autoUpdate's normal-boot download reports fetch failures via
    // reportFetchFailure(), which attributes the incident to a venueId resolved
    // from the in-memory settings. Load them now on the normal-boot branch only (empty args);
    // the --update/--remove branches chdir and relaunch and must not read/create
    // settings here, and they never hit the reporting path anyway.
    if (args.length === 0) {
      await loadSettings();
    }
    try {
      await autoUpdate(args);
    } catch (err) {
      logger.error(
        'Auto-update failed (network not ready?), continuing startup:',
        err
      );
    }
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
      res.status(200).send(getPublicSettings());
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
    const url =
      'https://api.github.com/repos/Knorcedger/quickord-printer-server/releases/latest';
    try {
      const result = await tryFetchWithFallback<{
        name?: string;
        tag_name?: string;
      }>({
        url,
        method: 'GET',
        fetchFn: async () => {
          const response = await fetch(url);
          if (!response.ok) throw httpStatusError(response);
          return {
            data: (await response.json()) as {
              name?: string;
              tag_name?: string;
            },
          };
        },
        curlFn: () => curlExecJson(`curl -s -L "${url}"`),
      });
      return result.data.name || result.data.tag_name || 'unknown';
    } catch (err) {
      console.error('fetch failed:', err);
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

  // Restart this process. Triggered by the HTTP route (legacy/local) and by a
  // backend restart command over the pull channel / WebSocket (remote).
  //
  // We do NOT respawn ourselves. A detached spawn is what used to take the
  // server out from under the service manager: WinSW saw its child exit
  // cleanly, marked the service Stopped, and the survivor kept running as an
  // orphan on the port — no supervision, no logs. It also carried the current
  // argv over, so a process that had been left with the update chain's
  // `--remove ...` args re-entered that branch and skipped the version check
  // entirely, which is why a remote update silently did nothing.
  //
  // Instead: exit and let the SCM start us clean, with no args, so a restart
  // always means "boot + version check".
  async function doRestart(): Promise<void> {
    const isDev = process.argv[1]?.endsWith('.ts');
    if (isDev) {
      process.exit(0);
    }

    // A non-zero exit is only meaningful as "restart me" if WinSW is our
    // parent. Orphaned instances exit 0 and rely on the watchdog below, which
    // also brings them back under the SCM.
    const managed = await isServiceManaged();
    logger.info(
      `Restarting (service-managed: ${managed}); the SCM will start a fresh instance`
    );
    scheduleServiceStartWatchdog();

    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      process.exit(managed ? 1 : 0);
    };
    // Keep-alive sockets can hold server.close() open indefinitely; the port is
    // released by the exit anyway.
    setTimeout(exit, 3000);
    server.close(exit);
  }

  function restartServer(): void {
    // Short delay so the HTTP response flushes before the process goes away.
    setTimeout(() => {
      void doRestart();
    }, 500);
  }

  // Let a backend restartRequest trigger the same restart path as the HTTP route.
  setRestartHandler(restartServer);

  // Explicit version check on demand, without a restart: when there is nothing
  // newer the server keeps serving, and the caller gets told so. When there is,
  // downloadLatestCode hands over to the update chain and this process exits —
  // beforeHandoff is the caller's last chance to be heard before that.
  setUpdateHandler(async (beforeHandoff) => {
    if (process.platform !== 'win32') {
      return { error: 'Auto-update is only supported on Windows', state: 'failed' as const };
    }
    return downloadLatestCode(3000, beforeHandoff);
  });

  app.post('/restart', (req: Request, res: Response) => {
    res.status(200).send({ status: 'restarting' });
    restartServer();
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
  app.route('/print-full-order').post(dedup, printFullOrders);
  app.route('/print-order-comments').post(dedup, printOrderComments);

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

  // 404 catch-all — must come AFTER all route handlers but BEFORE the error
  // handler. Without this, Express's default 404 returns an HTML page
  // ("Cannot POST /xxx") which breaks JSON-expecting clients (FE does
  // response.json() → "Unexpected token '<'"). Returning JSON keeps client
  // error reporting clean and signals "endpoint not present in this PS
  // version" unambiguously.
  app.use((req: Request<{}, any, any>, res: Response<{}, any>) => {
    res.status(404).json({
      errors: [
        {
          code: 'ROUTE_NOT_FOUND',
          message: `Route ${req.method} ${req.url} not found on this printer-server version`,
        },
      ],
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

      res.status(status).json({ errors: [{ message: err.message }] });
    }
  );

  // start server
  server = app.listen(SERVER_PORT, () => {
    logger.info(
      'API listening at port',
      (server?.address?.() as { port: number })?.port
    );

    // Self-register printer server IP with the backend
    const venueId = getSettings().venueId || getModems()[0]?.venueId;

    if (venueId) {
      registerPrinterServerIp(venueId);
    } else {
      logger.info(
        'No venueId configured, skipping printer server IP registration'
      );
    }

    // Sole backend channel: long-poll the backend and pull jobs to print. Also
    // carries liveness, control ops (check/scan/restart/update), test prints, and
    // version reporting.
    initPullClient();
  });

  // Without this, a failed bind is swallowed and the service reports itself as
  // started while nothing is listening — exactly what happens when an orphaned
  // instance is still holding the port. Only a bind failure is worth exiting
  // for; any other server error is logged and the process stays up.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
      logger.error(
        `Problem: http server error on port ${SERVER_PORT} (${err.code || err.message})`
      );
      return;
    }
    void handleBindFailure(err, SERVER_PORT);
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
