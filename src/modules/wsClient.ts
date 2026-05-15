/**
 * WebSocket client that connects to the Quickord backend.
 * Receives raw ESC/POS print commands and sends them to local printers
 * via TCP (network printers) or a local device path (shared/USB/serial
 * printers, e.g. \\localhost\POS-80 on Windows).
 */
import WebSocket from 'ws';
import * as net from 'node:net';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  printer as ThermalPrinter,
  types as PrinterTypes,
} from 'node-thermal-printer';
import nconf from 'nconf';
import logger from './logger';

const execAsync = promisify(exec);

nconf.argv().env().file({ file: './config.json' });

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000;
const SOCKET_TIMEOUT = 5000;

function getBackendWsUrl(): string {
  const apiUrl = nconf.get('QUICKORD_API_URL') || 'https://api.quickord.com/graphql';
  const wsUrl = nconf.get('BACKEND_WS_URL');
  if (wsUrl) return wsUrl;
  return apiUrl.replace('/graphql', '').replace('https://', 'wss://').replace('http://', 'ws://');
}

// Cache venueId to avoid re-reading settings.json on every call
let cachedVenueId: string | null = null;

function getVenueId(): string {
  if (cachedVenueId !== null) return cachedVenueId;
  try {
    // Try existing settings module first
    const { getSettings } = require('./settings');
    const settings = getSettings();
    if (settings?.venueId) { cachedVenueId = settings.venueId; return cachedVenueId!; }
    if (settings?.modem?.venueId) { cachedVenueId = settings.modem.venueId; return cachedVenueId!; }
  } catch {}
  cachedVenueId = nconf.get('VENUE_ID') || '';
  return cachedVenueId!;
}

// Per-venue WS registration secret. Stored in settings.json (synced DB ->
// local by the frontend, same path as venueId), with an env fallback for
// manual provisioning. Fail-closed: no hardcoded fallback, so a leaked
// shared key can no longer impersonate other venues.
function getWsSecret(): string {
  try {
    const { getSettings } = require('./settings');
    const secret = getSettings()?.wsSecret;
    if (secret) return secret;
  } catch {}
  return nconf.get('VENUE_WS_SECRET') || '';
}

async function sendToPrinter(
  ip: string,
  port: number,
  data: Buffer
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) { settled = true; fn(); }
    };

    const socket = net.connect({ host: ip, port: port || 9100 }, () => {
      socket.write(data, () => {
        socket.end();
      });
    });
    socket.setTimeout(SOCKET_TIMEOUT);
    socket.on('close', () => settle(() => resolve()));
    socket.on('error', (err) => settle(() => { socket.destroy(); reject(err); }));
    socket.on('timeout', () => settle(() => { socket.destroy(); reject(new Error('Connection timeout')); }));
  });
}

// A Windows shared-printer write is fire-and-forget at the spooler:
// fs.writeFile to \\host\share reports success even when the physical
// printer is offline or the share does not exist. Gate on the printer's
// WMI WorkOffline state first (mirrors the legacy print path) so an
// offline printer fails loudly instead of returning a false success.
// Stricter than legacy: only an explicit `false` (share found AND not
// offline) counts as online — empty output means "share not found".
async function isWindowsSharedPrinterOnline(
  shareName: string
): Promise<boolean> {
  const command = `powershell -NoProfile -Command "Get-WmiObject -Query \\"SELECT * FROM Win32_Printer WHERE ShareName = '${shareName}'\\" | Select-Object -ExpandProperty WorkOffline"`;
  try {
    const { stdout } = await execAsync(command);
    return stdout.trim().toLowerCase() === 'false';
  } catch {
    return false;
  }
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
    const online = await isWindowsSharedPrinterOnline(shareName);
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

function checkPrinterConnectivity(ip: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(2000);
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function handleMessage(raw: string): Promise<void> {
  try {
    const msg = JSON.parse(raw);

    switch (msg.type) {
      case 'printRaw': {
        const { jobId, printerIp, printerPort, data } = msg;

        // A job needs an id, a payload, and at least one transport target:
        // an IP for TCP printers, or a device path in printerPort for
        // local shared/USB/serial printers.
        if (!jobId || !data || (!printerIp && !printerPort)) {
          logger.error('Invalid printRaw message: missing required fields');
          if (jobId) sendResult(jobId, 'failed', 'Missing required fields');
          return;
        }

        const buffer = Buffer.from(data, 'base64');

        let dispatch: Promise<unknown>;
        let target: string;

        if (printerIp) {
          const parsed = printerPort ? parseInt(printerPort, 10) : NaN;
          const port = Number.isFinite(parsed) ? parsed : 9100;
          target = `${printerIp}:${port}`;
          logger.info(`Received print job ${jobId} for ${target} (${buffer.length} bytes)`);
          dispatch = sendToPrinter(printerIp, port, buffer);
        } else {
          target = printerPort;
          logger.info(`Received print job ${jobId} for local printer ${target} (${buffer.length} bytes)`);
          dispatch = sendToLocalPrinter(printerPort, buffer);
        }

        dispatch
          .then(() => {
            logger.info(`Print job ${jobId} sent successfully to ${target}`);
            sendResult(jobId, 'success');
          })
          .catch((err) => {
            logger.error(`Print job ${jobId} failed for ${target}:`, err);
            sendResult(jobId, 'failed', err?.message ?? String(err));
          });
        break;
      }

      case 'checkPrintersRequest': {
        logger.info('Received printer check request');
        const printersToCheck: { id: string; ip: string; port?: string }[] = msg.data?.printers || msg.printers || [];
        const results = await Promise.all(
          printersToCheck.map(async (p) => {
            const port = p.port ? parseInt(p.port, 10) : 9100;
            const connected = await checkPrinterConnectivity(p.ip, Number.isFinite(port) ? port : 9100);
            return { id: p.id, connected };
          })
        );
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'checkPrintersResponse',
            data: { printers: results, venueId: getVenueId() },
          }));
        }
        break;
      }

      default:
        logger.info(`Unknown WS message type: ${msg.type}`);
    }
  } catch (err) {
    logger.error('Error handling WS message:', err);
  }
}

function sendResult(jobId: string, status: string, error?: string): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'printRawResult',
        data: { jobId, status, error, venueId: getVenueId() },
      })
    );
  } else {
    logger.error(`Cannot send print result for job ${jobId} — WebSocket not open (status: ${status})`);
  }
}

function connect(): void {
  const url = getBackendWsUrl();
  const venueId = getVenueId();
  const secret = getWsSecret();

  if (!venueId) {
    logger.info('No venueId configured, skipping WebSocket connection');
    return;
  }

  if (!secret) {
    logger.error(
      'No wsSecret configured (settings.json / VENUE_WS_SECRET), refusing WebSocket connection'
    );
    return;
  }

  logger.info(`Connecting to backend WebSocket: ${url}`);

  ws = new WebSocket(url);

  ws.on('open', () => {
    reconnectAttempts = 0;
    logger.info('WebSocket connected to backend');

    ws!.send(
      JSON.stringify({
        type: 'printerServerRegister',
        data: { secret, venueId },
      })
    );
  });

  ws.on('message', (data: WebSocket.Data) => {
    let message: string;
    if (typeof data === 'string') {
      message = data;
    } else if (Buffer.isBuffer(data)) {
      message = data.toString();
    } else if (Array.isArray(data)) {
      message = Buffer.concat(data).toString();
    } else {
      message = Buffer.from(data as ArrayBuffer).toString();
    }
    handleMessage(message);
  });

  ws.on('close', () => {
    logger.info('WebSocket connection closed');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    logger.error('WebSocket error:', err);
  });
}

function scheduleReconnect(): void {
  const delay = Math.min(
    1000 * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  reconnectAttempts++;
  logger.info(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  setTimeout(connect, delay);
}

export function initWebSocketClient(): void {
  connect();
}
