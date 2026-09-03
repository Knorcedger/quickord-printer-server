import { exec } from 'node:child_process';
import diagnosticsChannel from 'node:diagnostics_channel';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import logger from './logger';

const NETWORK_DOWN_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

export interface FetchFailureDetails {
  url: string;
  method: string;
  fetchErrorName?: string;
  fetchErrorMessage?: string;
  fetchErrorCode?: string;
  fetchErrorCause?: unknown;
  responseStatus?: number;
  // >1 means every retry failed too: fetch is broken here, not blipping.
  fetchAttempts: number;
  curlOk: boolean;
  networkDown: boolean;
  // A curl that answers fast where fetch hung means the link was fine.
  fetchDurationMs?: number;
  curlDurationMs?: number;
  // undefined = no mark: connect-phase failure, or a concurrent request to the
  // same method+URL consumed it first.
  socketReused?: boolean;
  // Set by callers tracking consecutive fallbacks (the pull loop).
  consecutiveFallbacks?: number;
}

export interface HttpResult<T> {
  data: T;
  viaFallback: boolean;
  // Attempts made, on both the success and fallback paths.
  fetchAttempts: number;
  fetchFailure?: FetchFailureDetails;
}

const extractErrorCode = (err: any): string | undefined => {
  if (!err) return undefined;
  if (typeof err.code === 'string') return err.code;
  const cause: any = err.cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  return undefined;
};

// ---------- socket-reuse tracing (observation only) ----------

// fetch reuses keep-alive sockets, curl never does: a socket the router killed
// can be handed back out and hang, looking like fetch is broken on the machine.
// Passive — the channel names are undici internals, so a rename costs the field.
const freshSockets = new WeakSet<object>();
const socketReuseByRequest = new Map<string, boolean>();
// Records only keys we're awaiting, so redirect hops can't accumulate forever.
// Refcounted: concurrent reports share a key, the first to finish must not stop
// tracing for the rest.
const inFlightTraceKeys = new Map<string, number>();
let reuseTracingStarted = false;

const trackTraceKey = (key: string): void => {
  inFlightTraceKeys.set(key, (inFlightTraceKeys.get(key) ?? 0) + 1);
};

const releaseTraceKey = (key: string): void => {
  const n = (inFlightTraceKeys.get(key) ?? 1) - 1;
  if (n > 0) {
    inFlightTraceKeys.set(key, n);
    return;
  }
  inFlightTraceKeys.delete(key);
  socketReuseByRequest.delete(key);
};

// Must match the setter's key exactly: undici's request.path is pathname+search
// and origin carries the host, so both belong in the key.
const requestTraceKey = (method: string, url: string): string | undefined => {
  try {
    const u = new URL(url);
    return `${method} ${u.origin}${u.pathname}${u.search}`;
  } catch {
    return undefined;
  }
};

const ensureSocketReuseTracing = (): void => {
  if (reuseTracingStarted) return;
  reuseTracingStarted = true;
  try {
    diagnosticsChannel.subscribe('undici:client:connected', (msg: any) => {
      if (msg?.socket) freshSockets.add(msg.socket);
    });
    diagnosticsChannel.subscribe('undici:client:sendHeaders', (msg: any) => {
      const request = msg?.request;
      if (!request?.method || !request?.path) return;
      const key = `${request.method} ${request.origin}${request.path}`;
      // delete() consumes the mark: fresh for the first request only. Consume
      // even when untracked, else the next request on it would look fresh.
      const wasFresh = msg?.socket ? freshSockets.delete(msg.socket) : false;
      // Only record for keys we're awaiting, so the map can't grow unbounded.
      if (!inFlightTraceKeys.has(key)) return;
      socketReuseByRequest.set(key, !wasFresh);
    });
  } catch (err) {
    logger.warn({ err }, 'socket-reuse tracing unavailable');
  }
};

const isNetworkDown = (err: any, responseStatus?: number): boolean => {
  if (responseStatus !== undefined) return false;
  const code = extractErrorCode(err);
  return code !== undefined && NETWORK_DOWN_CODES.has(code);
};

const buildFetchErrorContext = (
  url: string,
  method: string,
  err: any,
  responseStatus?: number
) => {
  const cause: any = err?.cause;
  return {
    url,
    method,
    fetchErrorName: err?.name,
    fetchErrorMessage: err?.message,
    fetchErrorCode: extractErrorCode(err),
    fetchErrorCause: cause
      ? { name: cause.name, message: cause.message, code: cause.code }
      : undefined,
    responseStatus,
  };
};

const finalize = (
  ctx: ReturnType<typeof buildFetchErrorContext>,
  fetchErr: any,
  fetchAttempts: number,
  curlOk: boolean,
  timings: Pick<
    FetchFailureDetails,
    'curlDurationMs' | 'fetchDurationMs' | 'socketReused'
  > = {}
): FetchFailureDetails => ({
  ...ctx,
  ...timings,
  fetchAttempts,
  curlOk,
  networkDown: isNetworkDown(fetchErr, ctx.responseStatus),
});

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ±50% spread, so retries from many venues don't land in the same instant.
const jittered = (ms: number): number => Math.round(ms * (0.5 + Math.random()));

// Failures that surface within seconds, so a retry costs little.
const CHEAP_RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
  'EPIPE',
]);

// AbortError is excluded: it fires only once the caller's whole timeout is
// spent, so a retry just doubles the wait before curl.
export const isCheapRetryableFetchError = (err: any): boolean => {
  if (err?.name === 'AbortError') return false;
  const status = err?.responseStatus;
  // The backend answered: retry a dyno restart, never a 4xx we'd re-earn.
  if (status !== undefined) return status >= 500;
  return CHEAP_RETRYABLE_CODES.has(extractErrorCode(err) ?? '');
};

// Measured as frequent and always curl-recovered, so no action attached. Gates
// the result path, which can't use the poll's streak. AbortError is absent: on
// its 10s timeout it's a real signal, unlike the poll's 45s budget.
export const isRecoveredFetchNoise = (f: FetchFailureDetails): boolean =>
  f.fetchErrorCode === 'UND_ERR_CONNECT_TIMEOUT';

// ---------- curl primitives (exec a raw curl command) ----------

export const curlExec = (
  cmd: string,
  opts: { encoding?: 'utf-8' | 'buffer' } = {}
): Promise<{ stdout: string | Buffer; stderr: string }> =>
  new Promise((resolve, reject) => {
    exec(
      cmd,
      {
        encoding: (opts.encoding ?? 'utf-8') as any,
        maxBuffer: 50 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          (err as any).stderr =
            typeof stderr === 'string' ? stderr : stderr?.toString();
          reject(err);
        } else {
          resolve({
            stdout,
            stderr: typeof stderr === 'string' ? stderr : stderr.toString(),
          });
        }
      }
    );
  });

export const curlExecJson = async (cmd: string): Promise<any> => {
  const { stdout } = await curlExec(cmd);
  return JSON.parse(stdout as string);
};

export const curlExecBuffer = async (cmd: string): Promise<Buffer> => {
  const { stdout } = await curlExec(cmd, { encoding: 'buffer' });
  return stdout as Buffer;
};

// Write a JSON payload to a temp file (avoids Windows shell-escaping issues)
// and pass the path to a function that runs the curl command.
export const withTempJsonPayload = async <R>(
  payload: unknown,
  fn: (tempFilePath: string) => Promise<R>
): Promise<R> => {
  const tempFilePath = path.join(os.tmpdir(), `api-payload-${Date.now()}.json`);
  try {
    fs.writeFileSync(tempFilePath, JSON.stringify(payload));
    return await fn(tempFilePath);
  } finally {
    try {
      fs.unlinkSync(tempFilePath);
    } catch {
      // ignore
    }
  }
};

// ---------- fetch-with-fallback core ----------

export interface FetchFnResult<T> {
  data: T;
  responseStatus?: number;
}

export interface TryFetchOpts<T> {
  url: string;
  method: string;
  fetchFn: () => Promise<FetchFnResult<T>>;
  curlFn: () => Promise<T>;
  // Extra fetch attempts before falling back to curl. Default 0 (single try).
  fetchRetries?: number;
  // Pause between fetch attempts. Default 500ms.
  retryDelayMs?: number;
  // Filters which failures the retries apply to. Defaults to all of them.
  shouldRetry?: (err: any) => boolean;
  // Drop the per-attempt failure dumps. For callers that already log their own
  // collapsed summary of an ongoing outage; the first failure must not set it,
  // or the detail is lost entirely.
  suppressFailureLogs?: boolean;
}

// Run fetchFn; if it throws (or returns non-2xx surfaced via thrown error),
// log structured details and run curlFn as fallback.
export const tryFetchWithFallback = async <T>(
  opts: TryFetchOpts<T>
): Promise<HttpResult<T>> => {
  const { url, method, fetchFn, curlFn } = opts;
  const maxAttempts = 1 + Math.max(0, opts.fetchRetries ?? 0);
  const retryDelayMs = opts.retryDelayMs ?? 500;
  const shouldRetry = opts.shouldRetry ?? (() => true);
  ensureSocketReuseTracing();
  const traceKey = requestTraceKey(method, url);
  if (traceKey) trackTraceKey(traceKey);
  let fetchErr: any;
  let responseStatus: number | undefined;
  let fetchDurationMs: number | undefined;
  let attempt = 0;

  // Fall back to curl only once every attempt fails, or the failure is one
  // retries can't help (shouldRetry).
  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    // Clear first, so a missing entry afterwards means headers never went out.
    if (traceKey) socketReuseByRequest.delete(traceKey);
    const startedAt = Date.now();
    try {
      const r = await fetchFn();
      if (attempt > 1) {
        // info, not warn: a recovery isn't an incident.
        logger.info(
          { url, method, attempt, maxAttempts },
          'fetch recovered on retry'
        );
      }
      // Consume the mark so unique (signed-URL) keys don't accumulate.
      if (traceKey) releaseTraceKey(traceKey);
      return { data: r.data, viaFallback: false, fetchAttempts: attempt };
    } catch (err: any) {
      fetchErr = err;
      responseStatus = err?.responseStatus;
      fetchDurationMs = Date.now() - startedAt;
      if (!shouldRetry(err)) break;
      // Jittered: a dyno restart fails every venue's poll at once, and a fixed
      // wait would march them all back onto the booting dyno together.
      if (attempt < maxAttempts) await sleep(jittered(retryDelayMs));
    }
  }

  const fetchAttempts = Math.min(attempt, maxAttempts);
  const ctx = buildFetchErrorContext(url, method, fetchErr, responseStatus);
  let socketReused: boolean | undefined;
  if (traceKey) {
    socketReused = socketReuseByRequest.get(traceKey);
    releaseTraceKey(traceKey);
  }
  if (!opts.suppressFailureLogs) {
    logger.error(
      { ...ctx, fetchAttempts, fetchDurationMs, socketReused },
      'fetch failed, attempting curl fallback'
    );
  }

  const curlStartedAt = Date.now();
  try {
    const data = await curlFn();
    const curlDurationMs = Date.now() - curlStartedAt;
    logger.info(
      { url, method, fetchAttempts, curlDurationMs },
      'curl fallback succeeded'
    );
    return {
      data,
      viaFallback: true,
      fetchAttempts,
      fetchFailure: finalize(ctx, fetchErr, fetchAttempts, true, {
        curlDurationMs,
        fetchDurationMs,
        socketReused,
      }),
    };
  } catch (curlErr: any) {
    if (!opts.suppressFailureLogs) {
      logger.error(
        {
          ...ctx,
          fetchAttempts,
          curlStderr: curlErr?.stderr || curlErr?.message,
        },
        'curl fallback also failed'
      );
    }
    const wrapped: any = new Error(
      `fetch and curl both failed for ${method} ${url}: ${fetchErr?.message}`
    );
    wrapped.cause = fetchErr;
    wrapped.fetchFailure = finalize(ctx, fetchErr, fetchAttempts, false, {
      curlDurationMs: Date.now() - curlStartedAt,
      fetchDurationMs,
      socketReused,
    });
    throw wrapped;
  }
};

// Throw helper that surfaces the HTTP status for the wrapper to capture.
export const httpStatusError = (response: Response): Error => {
  const err: any = new Error(`HTTP ${response.status} ${response.statusText}`);
  err.responseStatus = response.status;
  return err;
};
