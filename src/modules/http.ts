import { exec } from 'node:child_process';
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
  curlOk: boolean;
  networkDown: boolean;
}

export interface HttpResult<T> {
  data: T;
  viaFallback: boolean;
  fetchFailure?: FetchFailureDetails;
}

const extractErrorCode = (err: any): string | undefined => {
  if (!err) return undefined;
  if (typeof err.code === 'string') return err.code;
  const cause: any = err.cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  return undefined;
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
  curlOk: boolean
): FetchFailureDetails => ({
  ...ctx,
  curlOk,
  networkDown: isNetworkDown(fetchErr, ctx.responseStatus),
});

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
}

// Run fetchFn; if it throws (or returns non-2xx surfaced via thrown error),
// log structured details and run curlFn as fallback.
export const tryFetchWithFallback = async <T>(
  opts: TryFetchOpts<T>
): Promise<HttpResult<T>> => {
  const { url, method, fetchFn, curlFn } = opts;
  let fetchErr: any;
  let responseStatus: number | undefined;

  try {
    const r = await fetchFn();
    return { data: r.data, viaFallback: false };
  } catch (err: any) {
    fetchErr = err;
    responseStatus = err?.responseStatus;
  }

  const ctx = buildFetchErrorContext(url, method, fetchErr, responseStatus);
  logger.error(ctx, 'fetch failed, attempting curl fallback');

  try {
    const data = await curlFn();
    logger.info({ url, method }, 'curl fallback succeeded');
    return {
      data,
      viaFallback: true,
      fetchFailure: finalize(ctx, fetchErr, true),
    };
  } catch (curlErr: any) {
    logger.error(
      { ...ctx, curlStderr: curlErr?.stderr || curlErr?.message },
      'curl fallback also failed'
    );
    const wrapped: any = new Error(
      `fetch and curl both failed for ${method} ${url}: ${fetchErr?.message}`
    );
    wrapped.cause = fetchErr;
    wrapped.fetchFailure = finalize(ctx, fetchErr, false);
    throw wrapped;
  }
};

// Throw helper that surfaces the HTTP status for the wrapper to capture.
export const httpStatusError = (response: Response): Error => {
  const err: any = new Error(`HTTP ${response.status} ${response.statusText}`);
  err.responseStatus = response.status;
  return err;
};
