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
import { reportWebSocketFailure } from './api';
import logger from './logger';

const execAsync = promisify(exec);

nconf.argv().env().file({ file: './config.json' });

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
// The single pending reconnect timer. Owned so any new connect attempt can
// cancel it — otherwise an orphaned setTimeout(connect) from an earlier close
// fires later and spawns a second socket. Two sockets for one venue make the
// backend (which keeps one connection per venue) close-and-re-register them in
// an infinite ping-pong.
let reconnectTimer: NodeJS.Timeout | null = null;
// Fires once a connection has stayed open long enough to count as genuine, at
// which point we reset the back-off. A reject-close clears it first, so the
// back-off only resets for sockets that actually stick.
let stableTimer: NodeJS.Timeout | null = null;
// Gate the fatal "registration rejected" error to once per failure episode so a
// wrong secret doesn't spam the log every retry.
let authFailureLogged = false;
// Creds we last sent a printerServerRegister with, so reconnectWebSocketClient()
// can skip churning a healthy socket when settings sync with unchanged creds.
let registeredVenueId = '';
let registeredSecret = '';
const MAX_RECONNECT_DELAY = 60000;
const CONNECTION_STABLE_MS = 5000;
// Backend close codes that mean the creds are wrong (invalid venueId / invalid
// secret). Retrying the same creds is futile, so we slow-retry instead of
// hammering. Kept in sync with handlePrinterServerRegister in quickord-be.
const AUTH_FAILURE_CODES = new Set([4001, 4401]);
const SOCKET_TIMEOUT = 5000;
// Consecutive failures to ever OPEN the socket (firewall/proxy/TLS interception
// on the venue's machine rejecting the connection). Reset once a socket sticks.
let consecutiveConnectFailures = 0;
// Report the connection rejection to the BE once per failure episode so a
// permanently-blocked venue raises one Slack incident, not one every retry.
let connectionReportSent = false;
// Last classified 'error' so the 'close' handler can attribute the failure.
let lastWsError: { category: string; code: string; message: string } | null =
  null;
// Only alert after a few failures so a transient blip (router reboot, brief
// outage) self-heals quietly; a real block keeps failing past this.
const REPORT_AFTER_FAILURES = 3;

// Map a ws 'error' into a coarse category so the Slack incident and local log
// say *why* the connection was rejected (firewall vs proxy vs TLS interception
// vs DNS), which is what determines who fixes it on the venue's side.
function classifyWsError(err: any): {
  category: string;
  code: string;
  message: string;
} {
  const code: string = err?.code || err?.cause?.code || '';
  const message: string = err?.message || String(err);

  // An intercepting HTTP proxy that doesn't speak the WS upgrade replies with a
  // non-101 status; the ws library throws "Unexpected server response: <code>".
  if (/unexpected server response/i.test(message)) {
    return { category: 'PROXY_OR_UNEXPECTED_RESPONSE', code: code || message, message };
  }
  // Corporate MITM proxy / antivirus TLS interception.
  if (
    /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|SSL|TLS/i.test(code) ||
    /certificate|self.signed/i.test(message)
  ) {
    return { category: 'TLS_INTERCEPTION', code: code || 'TLS', message };
  }
  switch (code) {
    case 'EAI_AGAIN':
    case 'ENOTFOUND':
      return { category: 'DNS', code, message };
    case 'ECONNREFUSED':
      return { category: 'REFUSED', code, message };
    case 'ECONNRESET':
      return { category: 'RESET', code, message };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { category: 'UNREACHABLE', code, message };
    case 'ETIMEDOUT':
      return { category: 'TIMEOUT', code, message };
    default:
      return { category: 'UNKNOWN', code: code || 'UNKNOWN', message };
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function getBackendWsUrl(): string {
  const apiUrl =
    nconf.get('QUICKORD_API_URL') || 'https://api.quickord.com/graphql';
  const wsUrl = nconf.get('BACKEND_WS_URL');
  if (wsUrl) return wsUrl;
  return apiUrl
    .replace('/graphql', '')
    .replace('https://', 'wss://')
    .replace('http://', 'ws://');
}

// Get registered venueId from in-memory settings object.
function getVenueId(): string {
  try {
    const { getSettings } = require('./settings');
    const settings = getSettings();
    if (settings?.venueId) return settings.venueId;
    if (settings?.modem?.venueId) return settings.modem.venueId;
  } catch {}
  return nconf.get('VENUE_ID') || '';
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
  // Escape single quotes (WQL/PowerShell escape is doubling) so a crafted
  // share name can't break out of the quoted ShareName literal and inject
  // commands, even though the only writer is the authenticated backend.
  const safeShareName = shareName.replace(/'/g, "''");
  const command = `powershell -NoProfile -Command "Get-WmiObject -Query \\"SELECT * FROM Win32_Printer WHERE ShareName = '${safeShareName}'\\" | Select-Object -ExpandProperty WorkOffline"`;
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
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function handleMessage(raw: string): Promise<void> {
  try {
    const msg = JSON.parse(raw);

    switch (msg.type) {
      case 'printRaw': {
        const { jobId, printerIp, printerPort, data } = msg;

        // A job needs an id, a base64 string payload, and at least one
        // transport target: an IP for TCP printers, or a device path in
        // printerPort for local shared/USB/serial printers. `data` must be a
        // string — a non-string would throw in Buffer.from below and leave the
        // job unacknowledged, so reject it here with a terminal result instead.
        if (
          !jobId ||
          typeof data !== 'string' ||
          !data ||
          (!printerIp && !printerPort)
        ) {
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
          logger.info(
            `Received print job ${jobId} for ${target} (${buffer.length} bytes)`
          );
          dispatch = sendToPrinter(printerIp, port, buffer);
        } else {
          target = printerPort;
          logger.info(
            `Received print job ${jobId} for local printer ${target} (${buffer.length} bytes)`
          );
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
        const printersToCheck: { id: string; ip: string; port?: string }[] =
          msg.data?.printers || msg.printers || [];
        const results = await Promise.all(
          printersToCheck.map(async (p) => {
            const port = p.port ? parseInt(p.port, 10) : 9100;
            const connected = await checkPrinterConnectivity(
              p.ip,
              Number.isFinite(port) ? port : 9100
            );
            return { id: p.id, connected };
          })
        );
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'checkPrintersResponse',
              data: { printers: results, venueId: getVenueId() },
            })
          );
        }
        break;
      }

      case 'registered': {
        logger.info(`Registered with backend for venue ${msg.venueId}`);
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
    logger.error(
      `Cannot send print result for job ${jobId} — WebSocket not open (status: ${status})`
    );
  }
}

function connect(): void {
  // Connecting now supersedes any scheduled reconnect — drop the pending timer
  // so a stale slow-retry can't fire later and open a second, competing socket.
  clearReconnectTimer();

  // If a socket is already connecting/open, another lifecycle owns it. Creating
  // another would register a duplicate connection for this venue, which the
  // backend resolves by closing the older one — triggering an endless
  // close/re-register ping-pong between the two sockets.
  if (
    ws &&
    (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)
  ) {
    logger.info('connect: socket already live, skipping duplicate connection');
    return;
  }

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
  // Whether this socket ever reached 'open'. A close before open means the
  // connection was rejected at the transport level (firewall/proxy/TLS) — the
  // only failure mode worth a connection incident. Auth rejections and old-BE
  // skew both open first, so they never trip the report.
  let opened = false;

  ws.on('open', () => {
    opened = true;
    logger.info('WebSocket connected to backend');

    // Reset the back-off only once the socket proves stable — `open` fires
    // before registration, which the backend rejects (and closes) a moment
    // later on a bad secret. A reject-close clears this timer before it runs.
    stableTimer = setTimeout(() => {
      reconnectAttempts = 0;
      authFailureLogged = false;
      consecutiveConnectFailures = 0;
      connectionReportSent = false;
      lastWsError = null;
    }, CONNECTION_STABLE_MS);

    ws!.send(
      JSON.stringify({
        type: 'printerServerRegister',
        data: { secret, venueId },
      })
    );
    registeredVenueId = venueId;
    registeredSecret = secret;
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

  ws.on('close', (code: number) => {
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    logger.info(`WebSocket connection closed (code ${code})`);

    // Closed before ever opening => the venue's network rejected the connection
    // (firewall/proxy/TLS), not an auth or skew issue. After a few consecutive
    // such failures, report it once per episode so a permanently-blocked venue
    // raises a single Slack incident instead of one per retry.
    if (!opened) {
      consecutiveConnectFailures++;
      if (
        consecutiveConnectFailures >= REPORT_AFTER_FAILURES &&
        !connectionReportSent
      ) {
        connectionReportSent = true;
        const info = lastWsError ?? {
          category: 'UNKNOWN',
          code: `close_${code}`,
          message: `closed before open (code ${code})`,
        };
        reportWebSocketFailure({
          attempts: consecutiveConnectFailures,
          category: info.category,
          code: info.code,
          message: info.message,
          url: getBackendWsUrl(),
          venueId: getVenueId(),
        }).catch(() => {});
      }
    }

    scheduleReconnect(code);
  });

  ws.on('error', (err) => {
    lastWsError = classifyWsError(err);
    logger.error(
      `WebSocket error [${lastWsError.category}] code=${lastWsError.code}: ${lastWsError.message}`
    );
  });
}

function scheduleReconnect(closeCode?: number): void {
  // Only one reconnect may be pending at a time — drop any prior timer so
  // overlapping closes can't stack into multiple concurrent connect() calls.
  clearReconnectTimer();

  // Wrong venueId/secret: retrying the same creds can't succeed, so slow-retry
  // at the max delay (self-heals when creds are fixed) instead of hammering,
  // and log the error only once per failure episode.
  if (closeCode !== undefined && AUTH_FAILURE_CODES.has(closeCode)) {
    if (!authFailureLogged) {
      logger.error(
        `Registration rejected (code ${closeCode}) — check venueId/wsSecret. Slow-retrying every ${MAX_RECONNECT_DELAY}ms`
      );
      authFailureLogged = true;
    }
    reconnectTimer = setTimeout(connect, MAX_RECONNECT_DELAY);
    return;
  }

  const delay = Math.min(
    1000 * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  reconnectAttempts++;
  logger.info(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(connect, delay);
}

export function initWebSocketClient(): void {
  connect();
}

// Called after a /settings sync delivers venueId + wsSecret. Connects when we
// aren't already, or reconnects when the creds changed (e.g. secret rotation),
// so the printer-server registers without waiting for a process restart. No-ops
// on the frequent same-creds syncs so a healthy socket isn't churned.
export function reconnectWebSocketClient(): void {
  const venueId = getVenueId();
  const secret = getWsSecret();
  if (!venueId || !secret) {
    logger.info(
      `reconnectWebSocketClient: creds not ready (venueId: ${!!venueId}, wsSecret: ${!!secret}), skipping`
    );
    return;
  }

  const live =
    !!ws &&
    (ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING);
  const credsChanged =
    venueId !== registeredVenueId || secret !== registeredSecret;
  if (live && !credsChanged) {
    logger.info(
      'reconnectWebSocketClient: already connected with current creds, no-op'
    );
    return;
  }

  if (ws) {
    logger.info(
      credsChanged
        ? 'reconnectWebSocketClient: creds changed, reconnecting'
        : 'reconnectWebSocketClient: socket not live, reconnecting'
    );
    try {
      // removeAllListeners() drops the old socket's 'close' handler, so its
      // pending stable-timer would never be cleared and could later fire and
      // stomp the new socket's back-off state. Clear it here explicitly.
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      ws.removeAllListeners();
      ws.close();
    } catch (err) {
      logger.error('reconnectWebSocketClient: error closing old socket:', err);
    }
    ws = null;
  } else {
    logger.info('reconnectWebSocketClient: creds now available, connecting');
  }
  // A deliberate reconnect (new creds / recovered settings) starts a fresh
  // failure episode, so reset the full incident state — not just the back-off —
  // otherwise a previously-reported venue could never raise a second incident.
  reconnectAttempts = 0;
  authFailureLogged = false;
  consecutiveConnectFailures = 0;
  connectionReportSent = false;
  lastWsError = null;
  connect();
}
