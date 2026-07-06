/**
 * WebSocket client that connects to the Quickord backend.
 * Receives raw ESC/POS print commands and sends them to local printers
 * via TCP (network printers) or a local device path (shared/USB/serial
 * printers, e.g. \\localhost\POS-80 on Windows).
 */
import WebSocket from 'ws';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  printer as ThermalPrinter,
  types as PrinterTypes,
} from 'node-thermal-printer';
import nconf from 'nconf';
import { reportWebSocketFailure } from './api';
import { getBackendWsUrl } from './backendUrl';
import { isUSBPrinterOnline } from './common';
import logger from './logger';
import scanNetworkForConnections from './network';
import { checkPrinters } from './printer';

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
// Client-side keepalive timer. A dyno restart or a laptop sleeping can drop the
// TCP connection without a close frame ever reaching us, leaving readyState
// OPEN (half-open). Without an outbound ping the socket looks alive forever and
// reconnectWebSocketClient() keeps no-op'ing, so the printer-server silently
// stops receiving jobs. We ping the backend and terminate if a pong is missed.
let heartbeatTimer: NodeJS.Timeout | null = null;
// Gate the fatal "registration rejected" error to once per failure episode so a
// wrong secret doesn't spam the log every retry.
let authFailureLogged = false;
// Creds we last sent a printerServerRegister with, so reconnectWebSocketClient()
// can skip churning a healthy socket when settings sync with unchanged creds.
let registeredVenueId = '';
let registeredSecret = '';
const MAX_RECONNECT_DELAY = 60000;
const CONNECTION_STABLE_MS = 5000;
// Ping cadence for the keepalive. A missed pong over one interval terminates the
// socket, so half-open detection takes at most ~2x this. Kept below the backend's
// own 25s heartbeat so either side notices a dead peer promptly.
const HEARTBEAT_INTERVAL_MS = 20000;
// Backend close codes that mean the creds are wrong (invalid venueId / invalid
// secret). Retrying the same creds is futile, so we slow-retry instead of
// hammering. Kept in sync with handlePrinterServerRegister in quickord-be.
const AUTH_FAILURE_CODES = new Set([4001, 4401]);
const SOCKET_TIMEOUT = 5000;
// Abort a connection attempt whose opening handshake (TCP + TLS + WS upgrade)
// doesn't finish in time. Without it, a firewall/proxy that accepts the TCP SYN
// but black-holes the upgrade leaves the socket in CONNECTING forever: no
// 'open'/'close'/'error' ever fires, so no reconnect is scheduled and the
// duplicate-connection guard no-ops every future connect(). The timeout makes
// ws emit 'error'+'close', handing recovery to the normal back-off.
const HANDSHAKE_TIMEOUT_MS = 15000;
// Belt-and-suspenders sweep: catches cases the event-driven path missed — a
// socket stuck in CONNECTING (should be prevented by handshakeTimeout, but this
// backstops it independently), or dead with no reconnect pending (a 'close' that
// never fired, a lost timer). Reconnect stays event-driven; this only steps in
// when that path failed.
const WATCHDOG_INTERVAL_MS = 30000;
// How long a socket may sit in CONNECTING before the watchdog force-terminates
// it. Must clear HANDSHAKE_TIMEOUT_MS with margin so a legitimate in-progress
// handshake (or the handshakeTimeout itself firing) is never cut short.
const STUCK_CONNECTING_MS = 30000;
let watchdogTimer: NodeJS.Timeout | null = null;
// Wall-clock ms when the current connect() created its socket. Lets the watchdog
// tell a fresh, still-legitimate handshake from one wedged in CONNECTING.
let connectStartedAt = 0;
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

// Current PS version from the `version` file at the app root. Reported in the
// register payload so the backend can surface current-vs-latest version info.
function getPrinterVersion(): string {
  // Read cwd-relative first, exactly like autoupdate.ts: the packaged nexe exe's
  // __dirname points into the virtual snapshot FS and misses the real `version`
  // file sitting next to the exe, so the __dirname path throws in the Windows
  // service and we'd report 'unknown'. Fall back to __dirname for a plain
  // node-from-dist dev run, then to 'unknown' only if both fail.
  try {
    return fs.readFileSync('version', 'utf-8').trim();
  } catch {
    try {
      return fs
        .readFileSync(path.join(__dirname, '../../version'), 'utf-8')
        .trim();
    } catch {
      return 'unknown';
    }
  }
}

// Get registered venueId from in-memory settings object.
export function getVenueId(): string {
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
export function getWsSecret(): string {
  try {
    const { getSettings } = require('./settings');
    const secret = getSettings()?.wsSecret;
    if (secret) return secret;
  } catch {}
  return nconf.get('VENUE_WS_SECRET') || '';
}

// Restart trigger registered by index.ts, which owns the http server instance
// and the spawn-new-process logic. Called when the backend sends a restartRequest
// over the WS, so a restart can be triggered remotely (not only via HTTP).
let restartHandler: (() => void) | null = null;

export function setRestartHandler(fn: () => void): void {
  restartHandler = fn;
}

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
    .catch(() => {})
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
  if (offlineCodes.includes(code) || /timeout|offline|not found/i.test(message)) {
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

// Execute a single raw print job and report its outcome via `reportResult`.
// Shared by the WebSocket push path (test pages, result reported over the WS)
// and the long-poll pull path (regular jobs, result reported over HTTP), so the
// serialization, transport selection, and error classification stay identical
// regardless of how the job arrived. Fire-and-forget: it enqueues onto the
// per-printer chain and returns; the result flows back through the callback.
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

async function handleMessage(raw: string): Promise<void> {
  try {
    const msg = JSON.parse(raw);

    switch (msg.type) {
      case 'printRaw': {
        // Push path: the backend still pushes test pages over the WS and awaits
        // the result frame. Regular jobs now arrive via the long-poll pull loop.
        executePrintJob(msg, sendResult);
        break;
      }

      case 'checkPrintersRequest': {
        logger.info('Received printer check request');
        const requestedPrinters: { id: string; ip: string; port?: string }[] =
          msg.data?.printers || msg.printers || [];

        // The backend's typed checkPrintersRequest carries only { venueId } and
        // no printers list, because the printer-server already knows its own
        // printers. With no explicit list, check every locally-configured
        // printer via the same path as the /available HTTP endpoint — it handles
        // shared/USB printers (ip === '') that a bare TCP probe can't. An
        // explicit list is still honoured if the BE ever starts sending one.
        const results =
          requestedPrinters.length > 0
            ? await Promise.all(
                requestedPrinters.map(async (p) => {
                  const port = p.port ? parseInt(p.port, 10) : 9100;
                  const connected = await checkPrinterConnectivity(
                    p.ip,
                    Number.isFinite(port) ? port : 9100
                  );
                  return { id: p.id, connected };
                })
              )
            : await checkPrinters();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'checkPrintersResponse',
              requestId: msg.requestId,
              data: { printers: results, venueId: getVenueId() },
            })
          );
        }
        break;
      }

      case 'restartRequest': {
        logger.info('Received restart request from backend');
        if (restartHandler) {
          restartHandler();
        } else {
          logger.warn('No restart handler registered, ignoring restart request');
        }
        break;
      }

      case 'scanNetworkRequest': {
        logger.info('Received network scan request');
        const lanConnections = await scanNetworkForConnections();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'scanNetworkResponse',
              requestId: msg.requestId,
              data: { lanConnections, venueId: getVenueId() },
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

  connectStartedAt = Date.now();
  ws = new WebSocket(url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
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
        // supportsPull tells the backend this build runs the long-poll loop, so
        // it queues print jobs for us to pull instead of pushing them over the WS.
        data: {
          secret,
          supportsPull: true,
          venueId,
          version: getPrinterVersion(),
        },
      })
    );
    registeredVenueId = venueId;
    registeredSecret = secret;

    // Outbound keepalive: capture this socket so the timer can't ping a later
    // reconnect's socket. If a ping cycle elapses with no pong the peer is gone
    // (half-open) — terminate to fire 'close' and let the existing back-off
    // reconnect. The 'close' handler and reconnectWebSocketClient() clear it.
    const sock = ws!;
    let alive = true;
    sock.on('pong', () => {
      alive = true;
    });
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!alive) {
        logger.error('WebSocket keepalive: no pong, terminating dead socket');
        sock.terminate();
        return;
      }
      alive = false;
      try {
        sock.ping();
      } catch {
        sock.terminate();
      }
    }, HEARTBEAT_INTERVAL_MS);
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
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
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

// Periodic liveness sweep, a backstop for the event-driven reconnect. Three
// cases it handles, in order:
//  - OPEN, or a reconnect already scheduled -> the normal path owns it, no-op.
//  - CONNECTING past STUCK_CONNECTING_MS -> the handshake wedged (SYN accepted,
//    upgrade black-holed) and even handshakeTimeout didn't fire; terminate it so
//    'close' fires and the back-off takes over. A fresh handshake is left alone.
//  - otherwise dead (null / CLOSING / CLOSED) with nothing pending -> connect().
// Skips when creds aren't provisioned yet (a /settings sync will connect), so an
// un-provisioned PS doesn't churn every tick.
function startWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (reconnectTimer) return;
    if (!getVenueId() || !getWsSecret()) return;

    const state = ws?.readyState;
    if (state === WebSocket.OPEN) return;

    if (state === WebSocket.CONNECTING) {
      if (Date.now() - connectStartedAt <= STUCK_CONNECTING_MS) return;
      logger.error(
        'WebSocket watchdog: handshake stuck in CONNECTING, terminating'
      );
      ws?.terminate();
      return;
    }

    logger.error(
      'WebSocket watchdog: socket not live and no reconnect pending, forcing reconnect'
    );
    connect();
  }, WATCHDOG_INTERVAL_MS);
}

export function initWebSocketClient(): void {
  startWatchdog();
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
      // removeAllListeners() drops the old socket's 'close' handler, so clear
      // its keepalive here too — otherwise the interval would ping a socket
      // we're discarding.
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
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
