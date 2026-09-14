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

const rotate = async () => {
  const size = await fs
    .stat(`${_filename}.log`)
    .then((s) => s.size)
    .catch(() => 0);
  if (size < MAX_LOG_BYTES) return;

  await fs.rm(`${_filename}.${LOG_GENERATIONS - 1}.log`, { force: true });
  for (let i = LOG_GENERATIONS - 2; i >= 1; i -= 1) {
    await fs
      .rename(`${_filename}.${i}.log`, `${_filename}.${i + 1}.log`)
      .catch(() => {});
  }
  await fs.rename(`${_filename}.log`, `${_filename}.1.log`).catch(() => {});
};

const format = (args: unknown[]) =>
  `${new Date().toISOString()} ${args
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
    .join(' ')}\n`;

const appendLog = async (...args: unknown[]) => {
  const line = format(args);
  await enqueue(async () => {
    await rotate();
    await fs.appendFile(`${_filename}.log`, line);
  });
};

const info = (...args: unknown[]) => {
  appendLog(...args);
  signale.info(...args);
};
const error = (...args: unknown[]) => {
  appendLog(...args);
  signale.error(...args);
};
const warn = (...args: unknown[]) => {
  appendLog(...args);
  signale.warn(...args);
};
const init = async (filename: string = 'app') => {
  _filename = filename;

  await appendLog(
    `--- Log opened at ${new Date()}. OS: ${process.platform}, pid: ${process.pid} ---`
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
  error,
  info,
  init,
  warn,
};
