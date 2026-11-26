import {
  types as PrinterTypes,
  printer as ThermalPrinter,
} from 'node-thermal-printer';
import nconf from 'nconf';
import logger from './logger';
import { hasPendingPrinterJob } from './printerQueue';
import { IPrinterSettings, ISettings } from './settings';
import { isUSBPrinterOnline } from './usbPrinter';

const printers: [ThermalPrinter, IPrinterSettings][] = [];

// How long a single TCP connect probe waits before timing out.
// Raised from the library default of 3000ms because WiFi printers waking
// from power-save can take several seconds to answer the first SYN.
const PRINTER_CONNECT_TIMEOUT_MS = 6000;

// Status-check retry policy: a waking printer often fails the first probe.
// Give it a few attempts within a single check before declaring offline.
const PRINTER_CHECK_RETRIES = 3;
const PRINTER_CHECK_RETRY_DELAY_MS = 600;

// Last-known connection state per printer id, used to debounce a single
// transient failure across checks so the UI doesn't flap to offline.
const lastConnectedState = new Map<string, boolean>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Retries the network connection probe a few times before giving up, so a
// printer that is slow to wake from WiFi power-save gets a chance to respond
// within a single status check.
const isNetworkPrinterConnectedWithRetry = async (
  printer: ThermalPrinter,
  identifier: string
): Promise<boolean> => {
  for (let attempt = 1; attempt <= PRINTER_CHECK_RETRIES; attempt += 1) {
    const connected = await printer.isPrinterConnected();

    if (connected) {
      return true;
    }

    if (attempt < PRINTER_CHECK_RETRIES) {
      logger.info(
        `Printer ${identifier} probe ${attempt}/${PRINTER_CHECK_RETRIES} failed, retrying…`
      );

      await sleep(PRINTER_CHECK_RETRY_DELAY_MS);
    }
  }
  return false;
};

// --- WiFi printer keep-alive ----------------------------------------------
// Many WiFi thermal printers (the T80C-class units we ship) drop their WiFi
// association after a short idle period and are slow to re-associate, so the
// next status check or print finds them "offline" until they wake (see the
// retry logic above). A lightweight periodic probe keeps the radio awake
// between real jobs.
//
// The probe is the exact same zero-byte TCP connect that checkPrinters and the
// library already perform, so it can never print garbage or beep. The only
// real risk is colliding with a real job on printers that accept a single TCP
// connection at a time, so keep-alive is idle-gated: it skips any printer that
// is currently busy or had real activity within the cooldown window. USB
// printers have no radio to keep awake and are ignored entirely.
// Probe well under the printer's idle/sleep threshold so the radio stays
// associated. Measured on a T80C the threshold was >6 min, but it varies per
// venue AP, so 90s keeps a wide cross-venue margin at negligible cost. Tune
// per-deployment via "PRINTER_KEEPALIVE_INTERVAL_MS".
const PRINTER_KEEPALIVE_INTERVAL_MS = 90000;
const PRINTER_KEEPALIVE_COOLDOWN_MS = 10000;

// Per-printer-instance activity, used to keep keep-alive from colliding with
// real print jobs / status checks on single-socket printers.
const printerActivity = new WeakMap<
  ThermalPrinter,
  { busy: boolean; lastActivityAt: number }
>();

const markPrinterBusy = (printer: ThermalPrinter) => {
  printerActivity.set(printer, { busy: true, lastActivityAt: Date.now() });
};

const markPrinterIdle = (printer: ThermalPrinter) => {
  printerActivity.set(printer, { busy: false, lastActivityAt: Date.now() });
};

// True when the printer is free for a keep-alive probe: not mid-operation and
// not within the cooldown window after its last real activity.
const isPrinterFreeForKeepalive = (printer: ThermalPrinter): boolean => {
  const activity = printerActivity.get(printer);

  if (!activity) return true;

  if (activity.busy) return false;
  return Date.now() - activity.lastActivityAt >= PRINTER_KEEPALIVE_COOLDOWN_MS;
};

let keepaliveInterval: null | ReturnType<typeof setInterval> = null;
let keepaliveRunning = false;

// Probes each idle network printer once to keep its WiFi radio associated.
const runKeepaliveCycle = async () => {
  for (let i = 0; i < printers.length; i += 1) {
    const printer = printers[i]?.[0];
    const settings = printers[i]?.[1];

    // Only network printers have a radio to keep awake.
    if (!printer || !settings || settings.ip === '') {
      continue;
    }

    // Pull jobs bypass the busy flag, so also skip while the queue is active.
    if (
      !isPrinterFreeForKeepalive(printer) ||
      hasPendingPrinterJob(printerQueueKey(settings))
    ) {
      continue;
    }

    markPrinterBusy(printer);
    try {
      // Only refresh state on a successful probe. A single failed keep-alive
      // attempt (no retries) is weak evidence; leave "offline" decisions to
      // checkPrinters, which retries and applies the grace-cycle debounce.
      const connected = await printer.isPrinterConnected();

      if (connected) {
        lastConnectedState.set(settings.id || '', true);
      }
    } catch (error) {
      logger.warn(
        `Keep-alive probe errored for ${settings.name || settings.ip}`,
        { error: error instanceof Error ? error.message : String(error) }
      );
    } finally {
      markPrinterIdle(printer);
    }
  }
};

export const stopPrinterKeepalive = () => {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
};

// Starts the WiFi keep-alive loop. Idempotent: clears any existing loop first,
// so it is safe to (re)call whenever printers are (re)configured. Disable by
// setting "PRINTER_KEEPALIVE_ENABLED": false in config.json; override the
// cadence with "PRINTER_KEEPALIVE_INTERVAL_MS".
export const startPrinterKeepalive = () => {
  stopPrinterKeepalive();

  if (nconf.get('PRINTER_KEEPALIVE_ENABLED') === false) {
    logger.info('Printer keep-alive disabled via config');
    return;
  }

  const hasNetworkPrinter = printers.some(([, s]) => Boolean(s) && s.ip !== '');

  if (!hasNetworkPrinter) {
    return;
  }

  const intervalMs =
    Number(nconf.get('PRINTER_KEEPALIVE_INTERVAL_MS')) ||
    PRINTER_KEEPALIVE_INTERVAL_MS;

  keepaliveInterval = setInterval(() => {
    if (keepaliveRunning) {
      // Previous cycle still in flight (e.g. several unreachable printers each
      // hitting the connect timeout); skip rather than overlap probes.
      return;
    }
    keepaliveRunning = true;
    runKeepaliveCycle()
      .catch((error) => {
        logger.error('Printer keep-alive cycle failed:', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        keepaliveRunning = false;
      });
  }, intervalMs);

  logger.info(`Printer keep-alive started (every ${intervalMs}ms)`);
};

// Same key printJob.ts uses (ip, else device path), so a status probe can see
// a pull job in progress on the same printer.
const printerQueueKey = (settings?: Pick<IPrinterSettings, 'ip' | 'port'>) =>
  settings?.ip || settings?.port || '';

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
      options: { timeout: PRINTER_CONNECT_TIMEOUT_MS },
      type: PrinterTypes.EPSON,
    };

    logger.info(
      `Setting up printer ${printerSettings.name || printerSettings.ip} with config:`,
      config
    );

    printers.push([new ThermalPrinter(config), printerSettings]);
  });

  // (Re)start the WiFi keep-alive loop for the freshly configured printers.
  startPrinterKeepalive();
};

export const checkPrinters = async () => {
  // Probe every printer in parallel. Each offline network printer costs up to
  // PRINTER_CHECK_RETRIES × PRINTER_CONNECT_TIMEOUT_MS (~19s); probing them
  // sequentially made a multi-printer venue blow past the backend's round-trip
  // budget (and Heroku's 30s router cap), so checkPrintersStatus timed out and
  // reported every printer offline. Distinct printers use distinct sockets, so
  // parallel probing is safe and caps total time at a single printer's worst
  // case.
  const results = await Promise.all(
    printers.map(async (entry, i) => {
      const settings = entry?.[1];
      const printer = entry?.[0];

      if (!settings || !printer) {
        logger.warn(
          'Skipping printer check: missing settings or printer instance',
          { index: i }
        );
        return null;
      }

      const printerIdentifier =
        settings.name || settings.id || settings.ip || settings.port;
      logger.info(`Checking printer connection: ${printerIdentifier}`);

      const printerId = settings?.id || '';

      // Probing mid-job could break a single-socket print; reuse the last state.
      const lastState = lastConnectedState.get(printerId);

      if (
        lastState !== undefined &&
        hasPendingPrinterJob(printerQueueKey(settings))
      ) {
        logger.info(
          `Printer ${printerIdentifier} has a job in progress, reporting last state`
        );
        return { id: printerId, connected: lastState };
      }

      // Hold off keep-alive while this status check probes the same socket.
      markPrinterBusy(printer);
      try {
        let connected = false;

        if (settings.ip !== '') {
          connected = await isNetworkPrinterConnectedWithRetry(
            printer,
            printerIdentifier
          );
          logger.info(
            `Network printer ${printerIdentifier} connection status: ${connected}`
          );
        } else {
          try {
            const shareName = settings.port.split('\\').pop() || '';
            connected = await isUSBPrinterOnline(shareName);
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
          lastConnectedState.set(printerId, true);
          logger.info(`Printer ${printerIdentifier} is online`);
          return { id: printerId, connected: true };
        }

        if (lastConnectedState.get(printerId) === true) {
          // Debounce: it was online last check, so give it one grace cycle
          // before flipping the UI to offline. Store false so the next failed
          // check is reported as offline.
          lastConnectedState.set(printerId, false);
          logger.warn(
            `Printer ${printerIdentifier} failed probe but was online last check, reporting online for one grace cycle`
          );
          return { id: printerId, connected: true };
        }
        lastConnectedState.set(printerId, false);
        logger.warn(`Printer ${printerIdentifier} is offline`);
        return { id: printerId, connected: false };
      } catch (error) {
        logger.error(
          `Error checking printer ${printerIdentifier} connection:`,
          {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }
        );
        return { id: printerId, connected: false };
      } finally {
        markPrinterIdle(printer);
      }
    })
  );

  const connectedPrinterIds = results.filter(
    (r): r is { connected: boolean; id: string } => r !== null
  );

  logger.info('Printer connection check complete', {
    connectedPrinters: connectedPrinterIds,
  });
  return connectedPrinterIds;
};
