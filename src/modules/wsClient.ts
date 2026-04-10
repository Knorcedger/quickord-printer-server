/**
 * WebSocket client that connects to the Quickord backend.
 * Receives raw ESC/POS print commands and sends them to local printers via TCP.
 */
import WebSocket from 'ws';
import * as net from 'node:net';
import nconf from 'nconf';
import logger from './logger';

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
  if (cachedVenueId) return cachedVenueId;
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

// Shared API key — same value used in modules/api.ts curl header
const API_KEY = nconf.get('API_KEY') || 'desktop_H2WRdpoSEh7iOWD2iCZD7msTKOs';

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

function handleMessage(raw: string): void {
  try {
    const msg = JSON.parse(raw);

    switch (msg.type) {
      case 'printRaw': {
        const { jobId, printerIp, printerPort, data } = msg;

        if (!jobId || !printerIp || !data) {
          logger.error('Invalid printRaw message: missing required fields');
          if (jobId) sendResult(jobId, 'failed', 'Missing required fields');
          return;
        }

        const buffer = Buffer.from(data, 'base64');
        const parsed = printerPort ? parseInt(printerPort, 10) : NaN;
        const port = Number.isFinite(parsed) ? parsed : 9100;

        logger.info(`Received print job ${jobId} for ${printerIp}:${port} (${buffer.length} bytes)`);

        sendToPrinter(printerIp, port, buffer)
          .then(() => {
            logger.info(`Print job ${jobId} sent successfully to ${printerIp}`);
            sendResult(jobId, 'success');
          })
          .catch((err) => {
            logger.error(`Print job ${jobId} failed for ${printerIp}:`, err.message);
            sendResult(jobId, 'failed', err.message);
          });
        break;
      }

      case 'checkPrintersRequest': {
        logger.info('Received printer check request');
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

  if (!venueId) {
    logger.info('No venueId configured, skipping WebSocket connection');
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
        data: { venueId, apikey: API_KEY },
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
    logger.error('WebSocket error:', err.message);
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
