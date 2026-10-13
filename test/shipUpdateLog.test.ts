import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LogLine } from '../src/modules/logger';

const enqueueLines = jest.fn((_lines: LogLine[]) => true);
jest.mock('../src/modules/logShipper', () => ({
  __esModule: true,
  enqueueLines: (lines: LogLine[]) => enqueueLines(lines),
}));

// eslint-disable-next-line import/first
import {
  MAX_LINES_PER_PASS,
  SHIPPED_MARKER,
  shipNewUpdateLogLines,
} from '../src/autoupdate/shipUpdateLog';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const shipped = () => enqueueLines.mock.calls.flatMap(([lines]) => lines);

describe('shipNewUpdateLogLines', () => {
  const cwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-shipupdatelog-'));
    process.chdir(dir);
    enqueueLines.mockClear();
    enqueueLines.mockImplementation(() => true);
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { force: true, recursive: true });
  });

  test('first run ships the last day only and leaves a marker', async () => {
    const recent = ago(60_000);
    fs.writeFileSync(
      'autoupdate.log',
      `${ago(48 * 3_600_000)} old run\n${recent} Preserved 2 log file(s).\n`
    );

    await expect(shipNewUpdateLogLines()).resolves.toBe(1);
    expect(shipped()).toEqual([
      {
        level: 'info',
        message: '[autoupdate] Preserved 2 log file(s).',
        ts: recent,
      },
    ]);
    expect(fs.readFileSync(SHIPPED_MARKER, 'utf8')).toBe(recent);
  });

  test('a second pass ships only what was written since', async () => {
    const first = ago(120_000);
    fs.writeFileSync('autoupdate.log', `${first} run one\n`);
    await shipNewUpdateLogLines();
    enqueueLines.mockClear();

    await expect(shipNewUpdateLogLines()).resolves.toBe(0);
    expect(enqueueLines).not.toHaveBeenCalled();

    const second = ago(1_000);
    fs.appendFileSync('autoupdate.log', `${second} run two\n`);
    await expect(shipNewUpdateLogLines()).resolves.toBe(1);
    expect(shipped().map((l) => l.message)).toEqual([
      '[autoupdate] run two',
    ]);
  });

  test('ERROR lines ship as errors and continuation lines stay attached', async () => {
    const ts = ago(1_000);
    fs.writeFileSync(
      'autoupdate.log',
      `${ts} ERROR Updater crashed: boom\n${ts} Service config applied: line 1\nline 2\n`
    );

    await shipNewUpdateLogLines();
    expect(shipped()).toEqual([
      { level: 'error', message: '[autoupdate] Updater crashed: boom', ts },
      {
        level: 'info',
        message: '[autoupdate] Service config applied: line 1\nline 2',
        ts,
      },
    ]);
  });

  test('reads the rotated generation first', async () => {
    fs.writeFileSync('autoupdate.1.log', `${ago(3_000)} older\n`);
    fs.writeFileSync('autoupdate.log', `${ago(1_000)} newer\n`);

    await shipNewUpdateLogLines();
    expect(shipped().map((l) => l.message)).toEqual([
      '[autoupdate] older',
      '[autoupdate] newer',
    ]);
  });

  test('an update loop is capped to the newest lines, and marked done', async () => {
    const lines = Array.from(
      { length: MAX_LINES_PER_PASS + 50 },
      (_, i) => `${ago((MAX_LINES_PER_PASS + 50 - i) * 1_000)} line ${i}`
    );
    fs.writeFileSync('autoupdate.log', `${lines.join('\n')}\n`);

    await shipNewUpdateLogLines();
    const out = shipped();
    expect(out).toHaveLength(MAX_LINES_PER_PASS);
    expect(out[0]!.message).toBe('[autoupdate] line 50');
    expect(fs.readFileSync(SHIPPED_MARKER, 'utf8')).toBe(
      out[out.length - 1]!.ts
    );
  });

  test('no marker is written when the shipper is not running', async () => {
    enqueueLines.mockImplementation(() => false);
    fs.writeFileSync('autoupdate.log', `${ago(1_000)} run\n`);

    await expect(shipNewUpdateLogLines()).resolves.toBe(0);
    expect(fs.existsSync(SHIPPED_MARKER)).toBe(false);
  });
});
