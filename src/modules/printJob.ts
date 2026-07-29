/**
 * Raw print-job execution.
 *
 * Takes a base64 ESC/POS payload the backend already formatted and sends it to a
 * local printer over TCP (network printers) or a device path (shared/USB/serial
 * printers, e.g. \\localhost\POS-80 on Windows). Drives the long-poll pull
 * client's print path; the per-printer serialization and error classification
 * live here so every job goes out the same way.
 */
import * as net from 'node:net';
import {
  printer as ThermalPrinter,
  types as PrinterTypes,
} from 'node-thermal-printer';
import { isUSBPrinterOnline } from './common';
import logger from './logger';

const SOCKET_TIMEOUT = 5000;

// Per-printer job queue. Thermal printers accept a single connection at a time,
// so two overlapping jobs to one device (copies, or two independent print
// requests at once) collide and only one ticket comes out. Chaining each job
// onto the previous one for that printer serializes them; distinct printers
// still print in parallel. The backend also serializes copies within a single
// request — this is the authoritative guard regardless of how jobs arrive.
const printerQueues = new Map<string, Promise<void>>();

// Pause between chained jobs to the same printer, giving it time to finish
// cutting/feeding before the next connection opens — sendToPrinter resolves on
// socket close, not print completion, so back-to-back connects would hit some
// printer models mid-cut. Parity with the backend push path's
// INTER_COPY_DELAY_MS, which paced copies before they moved to the pull channel.
const INTER_JOB_DELAY_MS = 500;

function enqueuePrinterJob(key: string, task: () => Promise<void>): void {
  const prev = printerQueues.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(task)
    .catch((err) => {
      // executePrintJob has its own try/catch and reports failures via its
      // callback, so a rejection surfacing here is an unexpected fault (e.g. a
      // bug before that try/catch). Log it once and keep the per-printer chain
      // alive for the jobs queued behind it.
      logger.error(`Unexpected error in printer queue for ${key}:`, err);
    })
    .then(() => new Promise<void>((r) => setTimeout(r, INTER_JOB_DELAY_MS)));
  printerQueues.set(key, next);
  // Drop the entry once it settles, unless a newer job has already chained on.
  void next.finally(() => {
    if (printerQueues.get(key) === next) printerQueues.delete(key);
  });
}

// Collapse the various ways an unreachable printer fails into a single stable
// code the frontend can translate. EHOSTDOWN/EHOSTUNREACH/ENETUNREACH (host or
// network down), ECONNREFUSED/ECONNRESET (port closed / connection dropped),
// ETIMEDOUT and our own 'Connection timeout' (no response) all mean the same
// thing to the user: the printer can't be reached. Anything else is an
// unexpected printing fault and gets a generic code.
function classifyPrinterError(err: any): string {
  const code: string = err?.code || err?.cause?.code || '';
  const message: string = err?.message || String(err);
  const offlineCodes = [
    'EHOSTDOWN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EPIPE',
  ];
  if (
    offlineCodes.includes(code) ||
    /timeout|offline|not found/i.test(message)
  ) {
    return 'PRINTER_OFFLINE';
  }
  return 'PRINTER_ERROR';
}

async function sendToPrinter(
  ip: string,
  port: number,
  data: Buffer
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const socket = net.connect({ host: ip, port: port || 9100 }, () => {
      socket.write(data, () => {
        socket.end();
      });
    });
    socket.setTimeout(SOCKET_TIMEOUT);
    socket.on('close', () => settle(() => resolve()));
    socket.on('error', (err) =>
      settle(() => {
        socket.destroy();
        reject(err);
      })
    );
    socket.on('timeout', () =>
      settle(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      })
    );
  });
}

// Local (non-TCP) printers: shared / USB / serial devices addressed by a
// device path in `printerPort` (e.g. \\localhost\POS-80 on Windows, or a
// serial device). The backend already produced the full ESC/POS buffer,
// so this is a pure raw passthrough — node-thermal-printer's File interface
// writes the bytes straight to the device, mirroring the legacy print path.
async function sendToLocalPrinter(
  deviceInterface: string,
  data: Buffer
): Promise<void> {
  // UNC share path (\\host\share): the raw write below silently
  // "succeeds" at the spooler, so verify the printer is actually online
  // before claiming success.
  if (deviceInterface.startsWith('\\\\')) {
    const shareName = deviceInterface.split('\\').pop() || '';
    const online = await isUSBPrinterOnline(shareName);
    if (!online) {
      throw new Error(`Printer offline or not found: ${deviceInterface}`);
    }
  }

  const printer = new ThermalPrinter({
    interface: deviceInterface,
    type: PrinterTypes.EPSON,
  });
  await printer.raw(data);
}

// Execute a single raw print job and report its outcome via `reportResult`.
// Drives the long-poll pull path (result reported over HTTP). Fire-and-forget:
// it enqueues onto the per-printer chain and returns; the result flows back
// through the callback.
export function executePrintJob(
  job: {
    data?: unknown;
    jobId?: string;
    printerIp?: string;
    printerPort?: string;
  },
  reportResult: (
    jobId: string,
    status: 'failed' | 'success',
    error?: string
  ) => void
): void {
  const { data, jobId, printerIp, printerPort } = job;

  // A job needs an id, a base64 string payload, and at least one transport
  // target: an IP for TCP printers, or a device path in printerPort for local
  // shared/USB/serial printers. `data` must be a string — a non-string would
  // throw in Buffer.from below and leave the job unacknowledged, so reject it
  // here with a terminal result instead.
  if (
    !jobId ||
    typeof data !== 'string' ||
    !data ||
    (!printerIp && !printerPort)
  ) {
    logger.error('Invalid print job: missing required fields');
    if (jobId) reportResult(jobId, 'failed', 'Missing required fields');
    return;
  }

  const buffer = Buffer.from(data, 'base64');

  // Key the queue by the physical target (ip for TCP, device path for local) so
  // jobs to the same printer serialize but different printers stay parallel.
  const queueKey = printerIp || printerPort!;
  enqueuePrinterJob(queueKey, async () => {
    let target: string;
    let dispatch: Promise<unknown>;

    if (printerIp) {
      const parsed = printerPort ? parseInt(printerPort, 10) : NaN;
      const port = Number.isFinite(parsed) ? parsed : 9100;
      target = `${printerIp}:${port}`;
      logger.info(
        `Received print job ${jobId} for ${target} (${buffer.length} bytes)`
      );
      dispatch = sendToPrinter(printerIp, port, buffer);
    } else {
      target = printerPort!;
      logger.info(
        `Received print job ${jobId} for local printer ${target} (${buffer.length} bytes)`
      );
      dispatch = sendToLocalPrinter(printerPort!, buffer);
    }

    try {
      await dispatch;
      logger.info(`Print job ${jobId} sent successfully to ${target}`);
      reportResult(jobId, 'success');
    } catch (err: any) {
      logger.error(`Print job ${jobId} failed for ${target}:`, err);
      // Surface a STABLE code, never the raw socket message. A printer that's
      // powered off / unplugged fails with different OS errors depending on
      // ARP-cache timing (EHOSTDOWN on the first try, a socket timeout once the
      // stale ARP entry is flushed), but to the user it's the same condition:
      // the printer is unreachable. The frontend maps PRINTER_OFFLINE to one
      // translated toast.
      reportResult(jobId, 'failed', classifyPrinterError(err));
    }
  });
}
