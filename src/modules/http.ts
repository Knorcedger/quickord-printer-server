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
  // How many times fetch was tried before giving up and falling back to curl.
  // 1 with the retry loop disabled; >1 means every retry failed too — the
  // "fetch is broken here, not a transient blip" signal.
  fetchAttempts: number;
  curlOk: boolean;
  networkDown: boolean;
  // A curl that answers fast where fetch hung means the link was fine.
  fetchDurationMs?: number;
  curlDurationMs?: number;
  // undefined = never got as far as sending headers (connect-phase failure).
  socketReused?: boolean;
  // Set by callers tracking consecutive fallbacks (the pull loop).
  consecutiveFallbacks?: number;
}

export interface HttpResult<T> {
  data: T;
  viaFallback: boolean;
  // Number of fetch attempts made (whether it eventually succeeded or fell
  // back to curl). Present on both the success and fallback paths.
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

// fetch reuses keep-alive sockets, curl never does. A socket the router killed
// can be handed back out and hang, which looks like fetch being broken on the
// machine — this flag tells the two apart. Passive; the channel names are
// undici internals, so a rename costs us the field, not the app.
const freshSockets = new WeakSet<object>();
const socketReuseByRequest = new Map<string, boolean>();
let reuseTracingStarted = false;

// Must match the setter's key exactly: undici's request.path is pathname+search
// and origin carries the host, so a signed URL's query and the target host both
// belong in the key (else socketReused is always undefined for query-bearing
// image/autoupdate URLs, and two hosts sharing a path would collide).
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
      // delete() consumes the mark: fresh for the first request on it only.
      const wasFresh = msg?.socket ? freshSockets.delete(msg.socket) : false;
      socketReuseByRequest.set(
        `${request.method} ${request.origin}${request.path}`,
        !wasFresh
      );
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

// AbortError is excluded: it only fires once the caller's whole timeout is
// spent (45s on the poll), so a retry doubles the wait before curl and gains
// nothing the next poll cycle wouldn't give for free.
export const isCheapRetryableFetchError = (err: any): boolean => {
  if (err?.name === 'AbortError') return false;
  const status = err?.responseStatus;
  // The backend answered: retry a dyno restart, never a 4xx we'd re-earn.
  if (status !== undefined) return status >= 500;
  return CHEAP_RETRYABLE_CODES.has(extractErrorCode(err) ?? '');
};

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
  // Extra fetch attempts before falling back to curl. Default 0 (single try,
  // original behavior). When >0, a fetch failure is retried up to this many
  // times — if a retry succeeds it was a transient blip; if all fail and curl
  // then works, the failure is fetch-specific.
  fetchRetries?: number;
  // Pause between fetch attempts. Default 500ms. Only consulted when
  // fetchRetries > 0.
  retryDelayMs?: number;
  // Filters which failures the retries apply to. Defaults to all of them.
  shouldRetry?: (err: any) => boolean;
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
      if (traceKey) socketReuseByRequest.delete(traceKey);
      return { data: r.data, viaFallback: false, fetchAttempts: attempt };
    } catch (err: any) {
      fetchErr = err;
      responseStatus = err?.responseStatus;
      fetchDurationMs = Date.now() - startedAt;
      if (!shouldRetry(err)) break;
      if (attempt < maxAttempts) await sleep(retryDelayMs);
    }
  }

  const fetchAttempts = Math.min(attempt, maxAttempts);
  const ctx = buildFetchErrorContext(url, method, fetchErr, responseStatus);
  let socketReused: boolean | undefined;
  if (traceKey) {
    socketReused = socketReuseByRequest.get(traceKey);
    socketReuseByRequest.delete(traceKey);
  }
  logger.error(
    { ...ctx, fetchAttempts, fetchDurationMs, socketReused },
    'fetch failed, attempting curl fallback'
  );

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
    logger.error(
      {
        ...ctx,
        fetchAttempts,
        curlStderr: curlErr?.stderr || curlErr?.message,
      },
      'curl fallback also failed'
    );
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
