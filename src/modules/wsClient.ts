/**
 * WebSocket client that connects to the Quickord backend.
 * Receives raw ESC/POS print commands and sends them to local printers via TCP/serial.
 */
import WebSocket from 'ws';
import * as net from 'node:net';
import nconf from 'nconf';
import logger from './logger';

nconf.argv().env().file({ file: './config.json' });

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000;

function getBackendWsUrl(): string {
  // Derive WS URL from the API URL
  const apiUrl = nconf.get('QUICKORD_API_URL') || 'https://api.quickord.com/graphql';
  const wsUrl = nconf.get('BACKEND_WS_URL');
  if (wsUrl) return wsUrl;
  // Convert https://api.quickord.com/graphql -> wss://api.quickord.com
  return apiUrl.replace('/graphql', '').replace('https://', 'wss://').replace('http://', 'ws://');
}

function getVenueId(): string {
  // Try to get venueId from settings.json first, then config
  try {
    const fs = require('fs');
    if (fs.existsSync('./settings.json')) {
      const settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));
      if (settings.venueId) return settings.venueId;
      if (settings.modem?.venueId) return settings.modem.venueId;
    }
  } catch {}
  return nconf.get('VENUE_ID') || '';
}

async function sendToPrinter(
  ip: string,
  port: number,
  data: Buffer
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(
      { host: ip, port: port || 9100, timeout: 5000 },
      () => {
        socket.write(data, () => {
          socket.destroy();
          resolve();
        });
      }
    );
    socket.on('error', (err) => {
      socket.destroy();
      reject(err);
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Connection timeout'));
    });
  });
}

function handleMessage(message: string): void {
  try {
    const msg = JSON.parse(message);

    switch (msg.type) {
      case 'printRaw': {
        const { jobId, printerIp, printerPort, data } = msg;
        const buffer = Buffer.from(data, 'base64');
        const port = printerPort ? parseInt(printerPort, 10) : 9100;

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
        // TODO: ping printers and respond
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

    // Register as printer server
    ws!.send(
      JSON.stringify({
        type: 'printerServerRegister',
        data: {
          venueId,
          apikey: 'desktop_H2WRdpoSEh7iOWD2iCZD7msTKOs',
        },
      })
    );
  });

  ws.on('message', (data: WebSocket.Data) => {
    handleMessage(data.toString());
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
