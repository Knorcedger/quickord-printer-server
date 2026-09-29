/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import logger from '../modules/logger';

/**
 * Logging for the update chain.
 *
 * The updater runs from %TEMP% and replaces the whole install directory
 * underneath itself (backupInstall renames it away), so it cannot write its log
 * where it belongs while it works. It buffers into %TEMP% instead and flushes
 * into <install>/builds/autoupdate.log on the way out — that file is what the
 * /logs zip ships. Before this, every one of these messages was a console.log
 * into a window that closed, which is why a failed update at a venue left no
 * trace at all.
 */

const PREFIX = 'quickord-update-';
const MAX_BYTES = 5 * 1024 * 1024;

const tempLogPath = path.join(tmpdir(), `${PREFIX}${process.pid}.log`);

const format = (args: unknown[]) =>
  `${new Date().toISOString()} ${args
    .map((arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      if (typeof arg === 'object' && arg !== null) return JSON.stringify(arg);
      return String(arg);
    })
    .join(' ')}\n`;

const write = (line: string) => {
  try {
    fs.appendFileSync(tempLogPath, line);
  } catch {
    // A log we cannot write must never break an update.
  }
};

// The same helpers run in the server (normal-boot version check) and in the
// updater child. Only the child has nowhere to write, so only it buffers.
let updaterMode = false;

export function markUpdaterProcess(): void {
  updaterMode = true;
}

export function updateLog(...args: unknown[]): void {
  if (!updaterMode) {
    logger.info(...args);
    return;
  }
  const line = format(args);
  write(line);
  console.log(line.trimEnd());
}

export function updateLogError(...args: unknown[]): void {
  if (!updaterMode) {
    logger.error(...args);
    return;
  }
  const line = format(args);
  write(line);
  console.error(line.trimEnd());
}

function rotate(target: string): void {
  try {
    if (fs.statSync(target).size < MAX_BYTES) return;
    fs.rmSync(`${target.replace(/\.log$/, '')}.1.log`, { force: true });
    fs.renameSync(target, `${target.replace(/\.log$/, '')}.1.log`);
  } catch {
    // No stat = no file yet = nothing to rotate.
  }
}

function appendInto(target: string, content: string): boolean {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    rotate(target);
    fs.appendFileSync(target, content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move this run's log into the install directory. Call on every exit path —
 * the interesting runs are the ones that failed.
 */
export function flushUpdateLog(installDir: string): void {
  let content = '';
  try {
    content = fs.readFileSync(tempLogPath, 'utf-8');
  } catch {
    return; // nothing was logged
  }

  const target = path.join(
    path.resolve(installDir),
    'builds',
    'autoupdate.log'
  );
  if (appendInto(target, content)) {
    fs.rmSync(tempLogPath, { force: true });
    return;
  }

  // The install directory is unusable (a rollback that failed). Leave the file
  // and say where it is, loudly — it is the only record of what happened.
  console.error(
    `Could not write ${target}. The update log was left at ${tempLogPath}`
  );
}

/**
 * Pick up logs from updaters that died before they could flush. Runs at boot,
 * from the builds directory, and only for pids that are gone — an updater that
 * is still finishing owns its file.
 */
export function absorbStrayUpdateLogs(): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(tmpdir());
  } catch {
    return;
  }

  for (const name of entries) {
    if (!name.startsWith(PREFIX) || !name.endsWith('.log')) continue;
    const pid = Number(name.slice(PREFIX.length, -'.log'.length));
    if (Number.isFinite(pid) && isAlive(pid)) continue;

    const full = path.join(tmpdir(), name);
    try {
      const content = fs.readFileSync(full, 'utf-8');
      if (appendInto(path.resolve('autoupdate.log'), content)) {
        fs.rmSync(full, { force: true });
      }
    } catch {
      // Skip it; the next boot tries again.
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = the process exists but belongs to someone else.
    return err?.code === 'EPERM';
  }
}
