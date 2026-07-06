/**
 * Long-poll pull client.
 *
 * Primary channel for receiving print jobs: instead of the backend pushing raw
 * ESC/POS over the WebSocket (fire-and-forget, lost on a half-open socket), the
 * printer-server pulls. It long-polls the backend for its venue's pending jobs,
 * runs each through the shared executePrintJob, and reports each outcome back
 * over HTTP. The WebSocket stays up as the liveness/control channel and still
 * carries test-page pushes.
 *
 * Delivery is at-most-once by design: the backend marks a job claimed the moment
 * it hands it to a poll, so a job is never re-delivered and can't double-print.
 * A job lost between claim and print ages out of the queue rather than reprinting
 * late; staff reprint manually if needed.
 */
import { reportFetchFailure } from './api';
import { getBackendBaseUrl } from './backendUrl';
import {
  curlExecJson,
  httpStatusError,
  tryFetchWithFallback,
  withTempJsonPayload,
} from './http';
import { executePrintJob, getVenueId, getWsSecret } from './wsClient';
import logger from './logger';

// Poll timeout must clear the backend's 25s hold with margin, so a healthy idle
// poll is answered empty by the server rather than aborted here.
const POLL_TIMEOUT_MS = 30_000;
const RESULT_TIMEOUT_MS = 10_000;
// A result report that fails gets retried on this schedule (fresh creds each
// attempt). The sum stays far below the backend's claim-result timeout, so a
// report that eventually lands still beats the sweep that would otherwise
// broadcast a false venue-wide failure for paper that actually printed.
const RESULT_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
// Back-off before retrying after a failed poll (uplink down, backend 5xx), so a
// hard outage doesn't spin the loop. A successful poll re-polls immediately.
const POLL_ERROR_BACKOFF_MS = 3_000;
// Rejected venue credentials won't fix themselves — a /settings sync has to
// land a new secret — so slow-retry instead of hammering the backend (matches
// the WS client's auth-failure handling).
const AUTH_RETRY_MS = 60_000;
// Re-check cadence while venueId/wsSecret aren't provisioned yet (a /settings
// sync will fill them in), so an un-provisioned PS doesn't hammer the backend.
const NO_CREDS_RETRY_MS = 5_000;

// The backend flattens into a body code because our curl fallback flattens
// HTTP status codes into parsed JSON — without this marker a 401 would look
// like a successful empty poll and the loop would spin with no backoff at all.
class PollRejectedError extends Error {}
// One auth incident log per episode; reset on the first successful poll.
let authFailureLogged = false;

// Belt-and-suspenders idempotency: the backend already claims a job once, but
// guard against ever running the same jobId twice. jobId -> expiry (ms).
const SEEN_TTL_MS = 120_000;
const seenJobs = new Map<string, number>();

// The poll loop runs continuously, so an unthrottled reportFetchFailure would
// raise a Slack incident per poll on a machine whose fetch is broken. One
// report per episode window is plenty — the curl fallback keeps jobs flowing.
const FETCH_FAILURE_REPORT_INTERVAL_MS = 60 * 60 * 1000;
let lastFetchFailureReportAt = 0;

let running = false;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function alreadySeen(jobId: string): boolean {
  const now = Date.now();
  for (const [id, expiry] of seenJobs) {
    if (expiry <= now) seenJobs.delete(id);
  }
  if (seenJobs.has(jobId)) return true;
  seenJobs.set(jobId, now + SEEN_TTL_MS);
  return false;
}

// POST JSON to the backend with the same fetch→curl fallback as every other
// PS→BE call (api.ts): on some venue machines Node's fetch is broken by a
// proxy while curl works, and without the fallback the pull loop would fail
// every poll forever while the rest of the app hums along.
async function postJson(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<any> {
  const url = `${getBackendBaseUrl()}${path}`;
  const result = await tryFetchWithFallback<any>({
    curlFn: () =>
      withTempJsonPayload(body, (tempFilePath) =>
        curlExecJson(
          `curl -s -m ${Math.ceil(timeoutMs / 1000)} -X POST "${url}" -H "Content-Type: application/json" --data-binary "@${tempFilePath}"`
        )
      ),
    fetchFn: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw httpStatusError(response);
        }
        return { data: await response.json() };
      } finally {
        clearTimeout(timer);
      }
    },
    method: 'POST',
    url,
  });

  if (result.viaFallback && result.fetchFailure) {
    const now = Date.now();
    if (now - lastFetchFailureReportAt > FETCH_FAILURE_REPORT_INTERVAL_MS) {
      lastFetchFailureReportAt = now;
      reportFetchFailure(result.fetchFailure).catch(() => {});
    }
  }
  return result.data;
}

// Report a job's outcome to the backend, retrying on failure. A dropped
// result is not just a lost metrics row: the backend's sweep would declare the
// job lost and broadcast a failure toast for paper that actually printed, so
// the report is worth several attempts. Detached from the pull loop — it must
// never block or crash it — and creds are re-read per attempt so a secret
// rotated mid-retry is picked up.
function reportResult(
  jobId: string,
  status: 'failed' | 'success',
  error?: string
): void {
  void (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await postJson(
          '/print-jobs/result',
          { error, jobId, secret: getWsSecret(), status, venueId: getVenueId() },
          RESULT_TIMEOUT_MS
        );
        // The curl fallback surfaces HTTP errors as parsed bodies, so a 4xx
        // arrives here as data without ok — treat anything unacknowledged as
        // a failed attempt.
        if (data?.ok === true) return;
        throw new Error(
          typeof data?.error === 'string' ? data.error : 'not acknowledged'
        );
      } catch (err) {
        const delay = RESULT_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          logger.error(
            `Failed to report print result for job ${jobId} after ${attempt + 1} attempts:`,
            err
          );
          return;
        }
        await sleep(delay);
      }
    }
  })();
}

async function pollOnce(): Promise<void> {
  const data = await postJson(
    '/print-jobs/poll',
    { secret: getWsSecret(), venueId: getVenueId() },
    POLL_TIMEOUT_MS
  );
  // See PollRejectedError: a 401 read through the curl fallback parses as a
  // body with this code instead of throwing.
  if (data?.code === 'AUTH_REJECTED') {
    throw new PollRejectedError(
      typeof data?.error === 'string' ? data.error : 'invalid venue credentials'
    );
  }
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  for (const job of jobs) {
    if (!job?.jobId || alreadySeen(job.jobId)) continue;
    // Only printRaw exists today; NACK anything else instead of base64-decoding
    // a future job kind and blasting it to a thermal printer as ESC/POS.
    if (job.type && job.type !== 'printRaw') {
      logger.error(
        `Skipping print job ${job.jobId} with unsupported type ${job.type}`
      );
      reportResult(job.jobId, 'failed', 'UNSUPPORTED_TYPE');
      continue;
    }
    executePrintJob(job, reportResult);
  }
}

async function loop(): Promise<void> {
  while (running) {
    if (!getVenueId() || !getWsSecret()) {
      await sleep(NO_CREDS_RETRY_MS);
      continue;
    }
    try {
      await pollOnce();
      authFailureLogged = false;
    } catch (err) {
      if (err instanceof PollRejectedError) {
        if (!authFailureLogged) {
          authFailureLogged = true;
          logger.error(
            `Print-job poll rejected (${err.message}) — check venueId/wsSecret. Slow-retrying every ${AUTH_RETRY_MS}ms`
          );
        }
        await sleep(AUTH_RETRY_MS);
        continue;
      }
      logger.error('Print-job poll failed:', err);
      await sleep(POLL_ERROR_BACKOFF_MS);
    }
  }
}

// Start the pull loop. Idempotent — a second call while already running no-ops.
export function initPullClient(): void {
  if (running) return;
  running = true;
  logger.info('Starting print-job pull loop');
  void loop();
}
