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
import scanNetworkForConnections from './network';
import { checkPrinters } from './printer';
import {
  executePrintJob,
  getPrinterVersion,
  getVenueId,
  getWsSecret,
  triggerRestart,
} from './wsClient';
import logger from './logger';

// Poll timeout must clear the backend's 25s hold with margin, so a healthy idle
// poll is answered empty by the server rather than aborted here. The margin is
// wide because this timer starts before the connection does: DNS + TCP + TLS
// come out of it, and on a slow venue uplink they alone can eat 5s (undici's
// own connect timeout is 10s). At 30s such a poll aborted while the backend was
// answering normally at 25s. Nothing is lost by waiting longer: a backend that
// genuinely hangs is cut by Heroku's 30s router timeout into an HTTP 503, which
// arrives as a status error rather than an abort.
const POLL_TIMEOUT_MS = 45_000;
const RESULT_TIMEOUT_MS = 10_000;
// Before falling back to curl, retry fetch this many extra times (up to 3 total
// attempts). If a retry succeeds the failure was a transient blip; if every
// attempt fails and only curl works, it's fetch-specific — the distinction we
// want to trace. Kept small: "retry everything" includes the poll's own 45s
// AbortError, and each retry re-holds the long poll, so a hung backend can
// stretch a cycle to ~2-3min before curl. 2 bounds that (prints only flow
// through this channel, and this only bites when the backend is already down).
// Poll-only: the poll has no deadline, while a result report races the
// backend's 120s claim-result timeout — retrying it would push its worst case
// to ~206s and have the sweep fail a receipt that actually printed.
const POLL_FETCH_RETRIES = 2;
const FETCH_RETRY_DELAY_MS = 500;
// A result report that fails gets retried on this schedule (fresh creds each
// attempt). The sum stays far below the backend's claim-result timeout, so a
// report that eventually lands still beats the sweep that would otherwise
// broadcast a false venue-wide failure for paper that actually printed.
const RESULT_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
// Back-off before retrying after a failed poll (uplink down, backend 5xx), so a
// hard outage doesn't spin the loop. A successful poll re-polls immediately.
const POLL_ERROR_BACKOFF_MS = 3_000;
// Spread applied to that back-off, as a fraction of it. A dyno restart fails
// every venue's held long-poll within the same millisecond, so a fixed wait
// would march all of them back onto the freshly-booted dyno together — a
// thundering herd landing exactly when it is least able to absorb one, which
// then risks failing them again in lockstep. Randomising each wait breaks the
// synchronisation after a single cycle.
const POLL_ERROR_BACKOFF_JITTER = 0.4;
// Rejected venue credentials won't fix themselves — a /settings sync has to
// land a new secret — so slow-retry instead of hammering the backend (matches
// the WS client's auth-failure handling).
const AUTH_RETRY_MS = 60_000;
// Re-check cadence while venueId/wsSecret aren't provisioned yet (a /settings
// sync will fill them in), so an un-provisioned PS doesn't hammer the backend.
const NO_CREDS_RETRY_MS = 5_000;

// Raised when the backend rejects the pull channel's credentials. Two triggers:
// (1) the HTTP status is 401 — the authoritative signal, works even against a
// backend that predates the poll endpoint (it 401s without the body code); or
// (2) an upgraded backend flattens the rejection into a body code because our
// curl fallback flattens HTTP status into parsed JSON. Without either, a 401
// would look like a successful empty poll and the loop would spin with no
// backoff at all — which is exactly what happens when the PS ships before the
// BE+FE poll changes are deployed.
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

// One jittered back-off wait, within ±POLL_ERROR_BACKOFF_JITTER of the base.
const pollErrorBackoffMs = (): number =>
  Math.round(
    POLL_ERROR_BACKOFF_MS *
      (1 + POLL_ERROR_BACKOFF_JITTER * (Math.random() * 2 - 1))
  );

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
// fetchRetries defaults to 0: only the deadline-free long poll can afford the
// extra attempts (see POLL_FETCH_RETRIES).
async function postJson(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  fetchRetries = 0
): Promise<any> {
  const url = `${getBackendBaseUrl()}${path}`;
  const result = await tryFetchWithFallback<any>({
    fetchRetries,
    retryDelayMs: FETCH_RETRY_DELAY_MS,
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
    // A 401 is an auth rejection, not the transient fetch/proxy failure the
    // curl fallback exists to paper over — curl just re-fetches the same 401,
    // and on a backend that predates the poll endpoint the 401 body carries no
    // authRejected code, so result.data would parse as a successful empty poll
    // and spin the loop. Surface it as a rejection regardless of body shape so
    // callers slow-retry. Scoped to the pull path (this postJson serves only
    // poll + result report); other PS→BE calls are untouched. Non-401 statuses
    // fall through to the fetch-failure report + normal error backoff below, so
    // we're not swallowing other errors — only the pull channel's own 401.
    if (result.fetchFailure.responseStatus === 401) {
      throw new PollRejectedError('backend rejected credentials (HTTP 401)');
    }
    // A single fetch attempt that curl then recovered is a known blip (the
    // caller's own timeout, or a dropped SYN — 20 events / 14 days / 8+ venues,
    // no print lost). With retries a blip recovers before reaching here, so
    // reaching it after 3 attempts is the persistent fetch-specific case worth
    // reporting. Gate on fetchAttempts, not the path: /print-jobs/result stays
    // at 0 retries for the claim-result window, so it keeps the suppression.
    const { curlOk, fetchAttempts, fetchErrorCode, fetchErrorName } =
      result.fetchFailure;
    const recoveredNoise =
      fetchAttempts === 1 &&
      curlOk &&
      (fetchErrorName === 'AbortError' ||
        fetchErrorCode === 'UND_ERR_CONNECT_TIMEOUT');
    const now = Date.now();
    if (
      !recoveredNoise &&
      now - lastFetchFailureReportAt > FETCH_FAILURE_REPORT_INTERVAL_MS
    ) {
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
  error?: string,
  result?: unknown
): void {
  void (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await postJson(
          '/print-jobs/result',
          {
            error,
            jobId,
            result,
            secret: getWsSecret(),
            status,
            venueId: getVenueId(),
          },
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
    // Piggyback the version so the backend can surface it without depending on
    // the WS register — the pull channel is the primary transport.
    {
      secret: getWsSecret(),
      venueId: getVenueId(),
      version: getPrinterVersion(),
    },
    POLL_TIMEOUT_MS,
    POLL_FETCH_RETRIES
  );
  // See PollRejectedError: a 401 read through the curl fallback parses as a
  // body with this code instead of throwing. Value mirrors the backend's
  // ERRORS.PRINT_JOBS.AUTH_REJECTED — keep the two in sync.
  if (data?.code === 'printJobs.authRejected') {
    throw new PollRejectedError(
      typeof data?.error === 'string' ? data.error : 'invalid venue credentials'
    );
  }
  // A successful poll always carries a jobs array (empty on an idle hold). A
  // body without one is an error the curl fallback didn't reject (a 5xx JSON
  // body: curl doesn't fail on HTTP status by default) — throw so the loop
  // hits its backoff instead of tight-looping with no pause.
  if (!Array.isArray(data?.jobs)) {
    throw new Error(
      `Unexpected poll response without a jobs array: ${JSON.stringify(data)?.slice(0, 200)}`
    );
  }
  const jobs = data.jobs;
  for (const job of jobs) {
    if (!job?.jobId || alreadySeen(job.jobId)) continue;
    dispatchJob(job);
  }
}

/**
 * Route one claimed job by its type. Prints (printRaw/testPrint) go through the
 * shared executePrintJob (per-printer serialization). Control commands run
 * immediately and in parallel — they must NOT queue behind print bytes, or a
 * user checking printer status during a print rush would wait for the queue to
 * drain. Each command is fire-and-forget: it reports its own result over HTTP,
 * so a slow probe never stalls the poll loop that dispatches the rest.
 */
function dispatchJob(job: {
  data?: unknown;
  jobId: string;
  printerIp?: string;
  printerPort?: string;
  type?: string;
}): void {
  switch (job.type) {
    // Undefined type is a legacy/print row; treat it as a raw print.
    case undefined:
    case 'printRaw':
    case 'testPrint':
      executePrintJob(job, reportResult);
      return;
    case 'checkPrinters':
      runCommand(job.jobId, async () =>
        reportResult(job.jobId, 'success', undefined, await checkPrinters())
      );
      return;
    case 'scanNetwork':
      runCommand(job.jobId, async () =>
        reportResult(
          job.jobId,
          'success',
          undefined,
          await scanNetworkForConnections()
        )
      );
      return;
    case 'restart':
      // Ack before exiting so the backend row settles; the process may die
      // before the report lands, which is harmless (the backend doesn't await
      // a restart result). Then trigger the actual restart.
      reportResult(job.jobId, 'success');
      triggerRestart();
      return;
    default:
      // A genuinely unknown kind: don't base64-decode it to a printer. NACK so
      // the backend's awaiting resolver gets a definite answer, not a timeout.
      logger.error(
        `Skipping job ${job.jobId} with unsupported type ${job.type}`
      );
      reportResult(job.jobId, 'failed', 'UNSUPPORTED_TYPE');
  }
}

/**
 * Run a control command's async body detached from the poll loop, reporting a
 * failed result if it throws. Keeps the loop dispatching subsequent jobs while
 * a slow probe (offline-printer retries, LAN scan) runs.
 */
function runCommand(jobId: string, body: () => Promise<void>): void {
  void body().catch((err) => {
    logger.error(`Command job ${jobId} failed:`, err);
    reportResult(
      jobId,
      'failed',
      err instanceof Error ? err.message : String(err)
    );
  });
}

async function loop(): Promise<void> {
  let firstLoop = true;
  while (running) {
    if (!getVenueId() || !getWsSecret()) {
      if (firstLoop) {
        logger.warn(
          `Print-job poll deferred — missing venueId or secret. Retry every ${NO_CREDS_RETRY_MS}.`
        );
        firstLoop = false;
      }
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
      await sleep(pollErrorBackoffMs());
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
