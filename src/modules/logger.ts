/* eslint-disable no-underscore-dangle */
import AdmZip from 'adm-zip';

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';

import process from 'node:process';

import signale from 'signale';

let _filename = 'app';

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

const appendLog = (
  level: LogLevel,
  args: unknown[],
  shippable: boolean
): void => {
  const ts = new Date().toISOString();
  const message = formatArgs(args);

  fs.appendFile(`${_filename}.log`, `${ts} ${message}\n`).catch(() => {});

  if (shippable) notify({ level, message, ts });
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

  const logs = (await fs.readdir('./')).filter(
    (file) => file.endsWith('.log') && file.startsWith(filename)
  );

  if (logs[0]) {
    if (logs[1]) {
      const log2 = await fs.readFile(`./${filename}.1.log`, 'utf8');
      await fs.writeFile(`${filename}.2.log`, log2);
    }

    const log1 = await fs.readFile(`./${filename}.log`, 'utf8');
    await fs.writeFile(`${filename}.1.log`, log1);
  }

  await fs.writeFile(
    `${filename}.log`,
    `${new Date().toISOString()} Log file created at ${new Date()}. OS: ${process.platform}\n`
  );
};

const possibleFiles = [
  'app.log',
  'app.1.log',
  'app.2.log',
  'autoupdate.log',
  'autoupdate.1.log',
  'autoupdate.2.log',
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
