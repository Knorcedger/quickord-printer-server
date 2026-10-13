// The updater is its own process, so its log never reaches the shipper: the
// server reads the new part of autoupdate.log back and spools it.
import fs from 'node:fs/promises';

import { enqueueLines } from '../modules/logShipper';
import type { LogLine } from '../modules/logger';

// Oldest first, so lines spool in the order they were written.
export const UPDATE_LOG_FILES = ['autoupdate.1.log', 'autoupdate.log'];
// Timestamp of the newest line already spooled; carried across updates by preserveLogs.
export const SHIPPED_MARKER = 'autoupdate.shipped';
// Without a marker (first boot of this build), older history is not worth a spool slot.
export const FIRST_RUN_WINDOW_MS = 24 * 60 * 60_000;
// An update loop must not crowd the server's own lines out of the spool.
export const MAX_LINES_PER_PASS = 500;

const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (.*)$/;
const ERROR_MARK = 'ERROR ';

const parse = (raw: string): LogLine[] => {
  const lines: LogLine[] = [];
  raw.split(/\r?\n/).forEach((text) => {
    const match = LINE.exec(text);
    if (match) {
      const isError = match[2]!.startsWith(ERROR_MARK);
      const body = isError ? match[2]!.slice(ERROR_MARK.length) : match[2]!;
      lines.push({
        level: isError ? 'error' : 'info',
        message: `[autoupdate] ${body}`,
        ts: match[1]!,
      });
    } else if (text && lines.length > 0) {
      // Multi-line output (e.g. an exec's stdout) belongs to the line above.
      lines[lines.length - 1]!.message += `\n${text}`;
    }
  });
  return lines;
};

const readMarker = async (): Promise<string> => {
  const fallback = new Date(Date.now() - FIRST_RUN_WINDOW_MS).toISOString();
  try {
    const ts = (await fs.readFile(SHIPPED_MARKER, 'utf8')).trim();
    return LINE.test(`${ts} x`) ? ts : fallback;
  } catch {
    return fallback;
  }
};

/** Spool the update-log lines not shipped yet. Returns how many were new. */
export async function shipNewUpdateLogLines(): Promise<number> {
  const since = await readMarker();
  const contents = await Promise.all(
    UPDATE_LOG_FILES.map((f) => fs.readFile(f, 'utf8').catch(() => ''))
  );
  const fresh = contents.flatMap(parse).filter((l) => l.ts > since);
  if (fresh.length === 0) return 0;

  if (!enqueueLines(fresh.slice(-MAX_LINES_PER_PASS))) return 0;
  const newest = fresh.reduce((max, l) => (l.ts > max ? l.ts : max), since);
  await fs.writeFile(SHIPPED_MARKER, newest);
  return fresh.length;
}
