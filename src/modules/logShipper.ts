/**
 * Store-and-forward of this PS's log lines to `POST /print-jobs/logs`. Lines are
 * spooled to disk first, so an outage shows up once the uplink is back.
 * Verbose (debug) lines are kept for a while and shipped only while staff have
 * verbose logs on. Off the print path: own timer, own backoff, bounded spool.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';

import { getBackendBaseUrl } from './backendUrl';
import {
  curlExecJson,
  httpStatusError,
  tryFetchWithFallback,
  withTempJsonPayload,
} from './http';
import { getPrinterVersion, getVenueId, getWsSecret } from './psIdentity';
import logger, { LogLine } from './logger';

export const SHIP_PATH = '/print-jobs/logs';
export const SPOOL_FILE = 'log-spool.jsonl';

// Spool caps; past either, the oldest lines go first.
export const MAX_SPOOL_ENTRIES = 5_000;
export const MAX_SPOOL_BYTES = 2 * 1024 * 1024;
// Stack traces and settings dumps: the head carries the diagnosis.
export const MAX_LINE_CHARS = 2_000;

// Per-upload caps: well under the backend's 1mb body limit, fine on weak 4G.
export const BATCH_MAX_ENTRIES = 300;
export const BATCH_MAX_BYTES = 256 * 1024;

// Verbose lines kept for when staff switch verbose on mid-incident.
export const DEBUG_KEEP_MS = 30 * 60_000;
export const MAX_DEBUG_ENTRIES = 3_000;

export const SHIP_INTERVAL_MS = 60_000;
export const VERBOSE_SHIP_INTERVAL_MS = 5_000;
const BACKLOG_SHIP_INTERVAL_MS = 5_000;
// Sooner after boot, so a restart loop shows up quickly.
export const FIRST_SHIP_DELAY_MS = 15_000;
// Spread each wait so a backend restart doesn't line the fleet up.
const SHIP_JITTER = 0.3;
// Waits after consecutive failed uploads (the last value repeats).
export const FAILURE_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];
// 404 (older backend) or 401 won't fix itself soon: keep spooling, retry rarely.
export const UNSUPPORTED_BACKOFF_MS = 60 * 60_000;
const UPLOAD_TIMEOUT_MS = 30_000;

interface SpoolEntry {
  level: LogLine['level'];
  msg: string;
  seq: number;
  ts: string;
}

// Marks process restarts in the backend logs (seq is persisted across them).
const bootId = randomUUID();

let queue: SpoolEntry[] = [];
let queueBytes = 0;
let debugCount = 0;
// Epoch ms the backend's verbose switch ends; 0 when off.
let verboseUntil = 0;
let nextSeq = 1;
// Lines dropped because the spool was full, reported with the next upload.
let dropped = 0;
// Appended since the last rewrite; trimming is in-memory, so compact past a cap.
let appendedBytes = 0;
let consecutiveFailures = 0;
let started = false;
let shipping = false;
let timer: NodeJS.Timeout | null = null;
// True while a timer is waiting (not while its ship runs).
let timerPending = false;
let unsubscribe: (() => void) | null = null;
// Serializes spool file writes so appends and rewrites never interleave.
let fileChain: Promise<void> = Promise.resolve();

const entryBytes = (entry: SpoolEntry): number =>
  Buffer.byteLength(JSON.stringify(entry)) + 1;

const jittered = (ms: number): number =>
  Math.round(ms * (1 + SHIP_JITTER * (Math.random() * 2 - 1)));

const withFile = (op: () => Promise<void>): Promise<void> => {
  fileChain = fileChain.then(op).catch(() => {
    // Only costs durability across a restart; the in-memory queue still ships.
  });
  return fileChain;
};

const rewriteSpool = (): Promise<void> =>
  withFile(async () => {
    const body = queue.map((e) => `${JSON.stringify(e)}\n`).join('');
    const tmp = `${SPOOL_FILE}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, SPOOL_FILE);
    appendedBytes = 0;
  });

const isVerbose = (): boolean => verboseUntil > Date.now();

const forget = (entry: SpoolEntry): void => {
  queueBytes -= entryBytes(entry);
  if (entry.level === 'debug') debugCount -= 1;
};

const removeWhere = (drop: (e: SpoolEntry) => boolean): number => {
  const before = queue.length;
  queue = queue.filter((e) => {
    if (!drop(e)) return true;
    forget(e);
    return false;
  });
  return before - queue.length;
};

// Verbose lines past their keep window; not a loss, they were never due.
const pruneDebug = (): number => {
  if (debugCount === 0) return 0;
  const cutoff = new Date(Date.now() - DEBUG_KEEP_MS).toISOString();
  return removeWhere((e) => e.level === 'debug' && e.ts < cutoff);
};

const trimToCaps = (): void => {
  if (debugCount > MAX_DEBUG_ENTRIES) {
    const oldest = queue.findIndex((e) => e.level === 'debug');
    if (oldest >= 0) forget(queue.splice(oldest, 1)[0]!);
  }
  while (
    queue.length > MAX_SPOOL_ENTRIES ||
    (queue.length > 1 && queueBytes > MAX_SPOOL_BYTES)
  ) {
    const oldest = queue.shift()!;
    forget(oldest);
    if (oldest.level !== 'debug') dropped += 1;
  }
};

const enqueue = (line: LogLine): void => {
  // Our own transport lines carry the URL; shipping them would feed back.
  if (line.message.includes(SHIP_PATH)) return;

  const msg =
    line.message.length > MAX_LINE_CHARS
      ? `${line.message.slice(0, MAX_LINE_CHARS)}… [truncated ${line.message.length - MAX_LINE_CHARS} chars]`
      : line.message;
  const entry: SpoolEntry = {
    level: line.level,
    msg,
    seq: nextSeq,
    ts: line.ts,
  };
  nextSeq += 1;
  queue.push(entry);
  const bytes = entryBytes(entry);
  queueBytes += bytes;
  if (entry.level === 'debug') debugCount += 1;
  trimToCaps();

  appendedBytes += bytes;
  if (appendedBytes > MAX_SPOOL_BYTES * 2) {
    void rewriteSpool();
  } else {
    void withFile(() =>
      fs.appendFile(SPOOL_FILE, `${JSON.stringify(entry)}\n`)
    );
  }
};

const loadSpool = async (): Promise<void> => {
  let raw: string;
  try {
    raw = await fs.readFile(SPOOL_FILE, 'utf8');
  } catch {
    return;
  }
  // An append that raced a rewrite can leave a line in twice.
  const bySeq = new Map<number, SpoolEntry>();
  raw.split('\n').forEach((line) => {
    if (!line) return;
    try {
      const e = JSON.parse(line);
      if (
        typeof e?.seq === 'number' &&
        typeof e?.ts === 'string' &&
        typeof e?.msg === 'string'
      ) {
        bySeq.set(e.seq, e);
      }
    } catch {
      // A torn last line from a crash mid-append; skip it.
    }
  });
  const restored = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  queue = restored;
  queueBytes = restored.reduce((sum, e) => sum + entryBytes(e), 0);
  debugCount = restored.filter((e) => e.level === 'debug').length;
  nextSeq = restored.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
  pruneDebug();
  trimToCaps();
  await rewriteSpool();
};

const takeBatch = (withDebug: boolean): SpoolEntry[] => {
  const batch: SpoolEntry[] = [];
  let bytes = 0;
  for (const entry of queue) {
    if (!withDebug && entry.level === 'debug') continue;
    const size = entryBytes(entry);
    if (batch.length >= BATCH_MAX_ENTRIES) break;
    if (batch.length > 0 && bytes + size > BATCH_MAX_BYTES) break;
    batch.push(entry);
    bytes += size;
  }
  return batch;
};

type UploadOutcome = 'failed' | 'ok' | 'unsupported';

const upload = async (
  body: Record<string, unknown>
): Promise<{ ackSeq?: number; outcome: UploadOutcome }> => {
  const url = `${getBackendBaseUrl()}${SHIP_PATH}`;
  const statusOf = (failure?: { responseStatus?: number }) =>
    failure?.responseStatus;

  let data: any;
  let status: number | undefined;
  try {
    const result = await tryFetchWithFallback<any>({
      // Would be shipped themselves; the spool already records the outage.
      suppressFailureLogs: true,
      curlFn: () =>
        withTempJsonPayload(body, (tempFilePath) =>
          curlExecJson(
            `curl -s -m ${Math.ceil(UPLOAD_TIMEOUT_MS / 1000)} -X POST "${url}" -H "Content-Type: application/json" --data-binary "@${tempFilePath}"`
          )
        ),
      fetchFn: async () => {
        const controller = new AbortController();
        const abort = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
        try {
          const response = await fetch(url, {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
            signal: controller.signal,
          });
          if (!response.ok) throw httpStatusError(response);
          return { data: await response.json() };
        } finally {
          clearTimeout(abort);
        }
      },
      method: 'POST',
      url,
    });
    data = result.data;
    status = statusOf(result.fetchFailure);
  } catch (err: any) {
    status = statusOf(err?.fetchFailure);
    if (status === 404 || status === 401) return { outcome: 'unsupported' };
    return { outcome: 'failed' };
  }

  if (data?.ok === true) {
    return {
      ackSeq: typeof data.ackSeq === 'number' ? data.ackSeq : undefined,
      outcome: 'ok',
    };
  }
  // The curl fallback flattens HTTP errors into parsed bodies.
  if (
    status === 404 ||
    status === 401 ||
    data?.code === 'printJobs.authRejected'
  )
    return { outcome: 'unsupported' };
  return { outcome: 'failed' };
};

/**
 * Upload one batch. Returns the delay until the next attempt. Exported for
 * tests; production drives it from the timer loop.
 */
export async function shipOnce(): Promise<number> {
  const verbose = isVerbose();
  const idle = verbose ? VERBOSE_SHIP_INTERVAL_MS : SHIP_INTERVAL_MS;
  if (shipping) return idle;
  if (pruneDebug() > 0) await rewriteSpool();
  const venueId = getVenueId();
  const secret = getWsSecret();
  const batch = takeBatch(verbose);
  if (!venueId || !secret || (batch.length === 0 && dropped === 0)) {
    return idle;
  }

  shipping = true;
  try {
    const reportedDropped = dropped;
    const { ackSeq, outcome } = await upload({
      bootId,
      dropped: reportedDropped,
      entries: batch,
      secret,
      venueId,
      version: getPrinterVersion(),
    });

    if (outcome !== 'ok') {
      consecutiveFailures += 1;
      if (outcome === 'unsupported') return UNSUPPORTED_BACKOFF_MS;
      return (
        FAILURE_BACKOFF_MS[
          Math.min(consecutiveFailures, FAILURE_BACKOFF_MS.length) - 1
        ] ?? SHIP_INTERVAL_MS
      );
    }

    consecutiveFailures = 0;
    dropped -= reportedDropped;
    // Only acknowledged lines leave the spool; unsent verbose lines stay.
    const lastSeq = ackSeq ?? batch[batch.length - 1]?.seq ?? 0;
    const removed = removeWhere(
      (e) => e.seq <= lastSeq && (verbose || e.level !== 'debug')
    );
    if (removed > 0) await rewriteSpool();
    // Backlog after an outage: keep draining.
    return takeBatch(isVerbose()).length > 0 ? BACKLOG_SHIP_INTERVAL_MS : idle;
  } finally {
    shipping = false;
  }
}

const schedule = (ms: number): void => {
  if (!started) return;
  timerPending = true;
  timer = setTimeout(async () => {
    timerPending = false;
    let next = SHIP_INTERVAL_MS;
    try {
      next = await shipOnce();
    } catch {
      // Never let the shipper crash the process or stop its own loop.
    }
    schedule(jittered(next));
  }, ms);
};

/**
 * Apply the backend's verbose-logs switch, read off each poll answer (absent
 * means off). Turning it on ships the kept verbose lines right away.
 */
export function setVerboseUntil(iso: unknown): void {
  const parsed = typeof iso === 'string' ? Date.parse(iso) : NaN;
  const next = Number.isFinite(parsed) ? parsed : 0;
  const turnedOn = next > Date.now() && !isVerbose();
  verboseUntil = next;
  if (!turnedOn) return;
  logger.info(`Verbose log shipping on until ${new Date(next).toISOString()}`);
  // A ship already running picks the faster pace up on its own.
  if (timerPending && timer) {
    clearTimeout(timer);
    schedule(1_000);
  }
}

/**
 * Start capturing log lines and shipping them. Call once, as early as possible
 * after logger.init() so boot lines are captured too. Idempotent.
 */
export async function initLogShipper(): Promise<void> {
  if (started) return;
  started = true;
  // Load first: an earlier append would reuse a seq the spool holds.
  await loadSpool();
  unsubscribe = logger.onLine(enqueue);
  schedule(jittered(FIRST_SHIP_DELAY_MS));
}

/** Test-only: stop the loop and forget all state. */
export async function resetLogShipperForTests(): Promise<void> {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
  unsubscribe?.();
  unsubscribe = null;
  await fileChain;
  queue = [];
  queueBytes = 0;
  debugCount = 0;
  verboseUntil = 0;
  timerPending = false;
  nextSeq = 1;
  dropped = 0;
  appendedBytes = 0;
  consecutiveFailures = 0;
  shipping = false;
}

/** Test-only: the in-memory spool. */
export const getQueueForTests = (): readonly SpoolEntry[] => queue;
export const getDroppedForTests = (): number => dropped;
