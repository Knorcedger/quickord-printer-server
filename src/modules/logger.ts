/* eslint-disable no-underscore-dangle */
/* eslint-disable no-await-in-loop */
import AdmZip from 'adm-zip';

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';

import process from 'node:process';

import signale from 'signale';

let _filename = 'app';

// Rotation is by size, not by boot: an update chain restarts the server two or
// three times in a row, so per-boot rotation threw away the boot that failed.
const MAX_LOG_BYTES = 10 * 1024 * 1024;
// app.log + app.1.log .. app.4.log
const LOG_GENERATIONS = 5;

// info/warn/error don't await appendLog, so every write goes through one chain
// — otherwise two writes could interleave with a rotation and lose lines.
let writeChain: Promise<void> = Promise.resolve();

const enqueue = (op: () => Promise<void>): Promise<void> => {
  writeChain = writeChain.then(op, op).catch(() => {});
  return writeChain;
};

// Bytes in the current log, counted here instead of a stat per line. Stat'd
// once from disk when unknown (first write, or after init switches files).
let logSize: number | null = null;

const rotate = async () => {
  if (logSize === null) {
    logSize = await fs
      .stat(`${_filename}.log`)
      .then((s) => s.size)
      .catch(() => 0);
  }
  if (logSize < MAX_LOG_BYTES) return;

  await fs.rm(`${_filename}.${LOG_GENERATIONS - 1}.log`, { force: true });
  for (let i = LOG_GENERATIONS - 2; i >= 1; i -= 1) {
    await fs
      .rename(`${_filename}.${i}.log`, `${_filename}.${i + 1}.log`)
      .catch(() => {});
  }
  // A locked file (AV) keeps growing; leave the count so the next line retries.
  await fs.rename(`${_filename}.log`, `${_filename}.1.log`).then(
    () => {
      logSize = 0;
    },
    () => {}
  );
};

export type LogLevel = 'debug' | 'error' | 'info' | 'warn';

export interface LogLine {
  level: LogLevel;
  message: string;
  ts: string;
}

type LineListener = (line: LogLine) => void;

// Sees every shippable line (logShipper); a listener can never break logging.
const lineListeners = new Set<LineListener>();

const formatArgs = (args: unknown[]): string =>
  args
    .map((arg) => {
      let out = '';

      if (arg instanceof Error) {
        const errorWithCause = arg as { cause?: unknown }; // Type assertion to include cause
        out = `${arg.name}: ${arg.message}${errorWithCause.cause ? ` (cause: ${errorWithCause.cause})` : ''}\n${arg.stack}`;
      } else if (typeof arg === 'object') {
        out = JSON.stringify(arg);
      } else {
        out = String(arg);
      }

      return out;
    })
    .join(' ');

const notify = (line: LogLine): void => {
  lineListeners.forEach((listener) => {
    try {
      listener(line);
    } catch {
      // A broken listener must never take logging down with it.
    }
  });
};

const appendLog = async (
  level: LogLevel,
  args: unknown[],
  shippable: boolean
) => {
  const ts = new Date().toISOString();
  const message = formatArgs(args);
  if (shippable) notify({ level, message, ts });

  const line = `${ts} ${message}\n`;
  await enqueue(async () => {
    await rotate();
    await fs.appendFile(`${_filename}.log`, line);
    logSize = (logSize ?? 0) + Buffer.byteLength(line);
  });
};

const info = (...args: unknown[]) => {
  appendLog('info', args, true);
  signale.info(...args);
};
// Local log only, never shipped: for lines carrying customer data.
const infoLocal = (...args: unknown[]) => {
  appendLog('info', args, false);
  signale.info(...args);
};
const error = (...args: unknown[]) => {
  appendLog('error', args, true);
  signale.error(...args);
};
const warn = (...args: unknown[]) => {
  appendLog('warn', args, true);
  signale.warn(...args);
};
// Verbose detail: kept briefly by the shipper and uploaded only while staff
// have verbose logs on. Skips the log file and console so neither grows.
const debug = (...args: unknown[]) => {
  notify({
    level: 'debug',
    message: formatArgs(args),
    ts: new Date().toISOString(),
  });
};

/**
 * Subscribe to every shippable log line. Returns an unsubscribe function.
 */
const onLine = (listener: LineListener): (() => void) => {
  lineListeners.add(listener);
  return () => {
    lineListeners.delete(listener);
  };
};
const init = async (filename: string = 'app') => {
  _filename = filename;
  logSize = null;

  await appendLog(
    'info',
    [
      `--- Log opened at ${new Date()}. OS: ${process.platform}, pid: ${process.pid} ---`,
    ],
    true
  );
};

const generations = (filename: string, count: number) => [
  `${filename}.log`,
  ...Array.from({ length: count - 1 }, (_, i) => `${filename}.${i + 1}.log`),
];

const possibleFiles = [
  ...generations('app', LOG_GENERATIONS),
  // Written by the updater, which runs from %TEMP% and flushes here when it
  // finishes. See autoupdate/updateLog.ts.
  ...generations('autoupdate', 2),
];

const createZip = () => {
  const zip = new AdmZip();

  possibleFiles.forEach((f) => {
    if (existsSync(`./${f}`)) {
      zip.addLocalFile(`./${f}`);
    }
  });

  return zip.toBuffer();
};

export default {
  createZip,
  debug,
  error,
  info,
  infoLocal,
  init,
  onLine,
  warn,
};
