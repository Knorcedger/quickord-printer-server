import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

type UpdateLog = typeof import('../src/autoupdate/updateLog');
type Logger = typeof import('../src/modules/logger').default;

// Fresh registry per test: the module latches updaterMode and its temp path.
const load = () => {
  let mod!: UpdateLog;
  let logger!: Logger;
  jest.isolateModules(() => {
    /* eslint-disable global-require */
    mod = require('../src/autoupdate/updateLog');
    logger = require('../src/modules/logger').default;
    /* eslint-enable global-require */
  });
  return { logger: logger as jest.Mocked<Logger>, mod };
};

// The module picks its temp path from tmpdir() at import time, so each test
// gets its own directory and they cannot see each other's files.
const useTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-updatelog-'));
  jest.spyOn(os, 'tmpdir').mockReturnValue(dir);
  return dir;
};

const install = (root: string) => {
  const builds = path.join(root, 'builds');
  fs.mkdirSync(builds, { recursive: true });
  return builds;
};

describe('update log', () => {
  let tmp: string;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    tmp = useTempDir();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmp, { force: true, recursive: true });
  });

  it('lands in the install directory, not in temp', () => {
    const { mod } = load();
    const root = path.join(tmp, 'quickord-cashier-server');
    const builds = install(root);

    mod.markUpdaterProcess();
    mod.updateLog('copying the build');
    mod.updateLogError('sc start returned 5');
    mod.flushUpdateLog(root);

    const written = fs.readFileSync(
      path.join(builds, 'autoupdate.log'),
      'utf8'
    );
    expect(written).toContain('copying the build');
    expect(written).toContain('sc start returned 5');
    expect(
      fs.readdirSync(tmp).filter((f) => f.startsWith('quickord-update-'))
    ).toHaveLength(0);
  });

  it('appends across updates instead of replacing', () => {
    const root = path.join(tmp, 'install');
    const builds = install(root);
    fs.writeFileSync(path.join(builds, 'autoupdate.log'), 'previous update\n');

    const { mod } = load();
    mod.markUpdaterProcess();
    mod.updateLog('this update');
    mod.flushUpdateLog(root);

    const written = fs.readFileSync(
      path.join(builds, 'autoupdate.log'),
      'utf8'
    );
    expect(written).toContain('previous update');
    expect(written).toContain('this update');
  });

  it('keeps the temp file when the install directory is unusable', () => {
    const { mod } = load();
    mod.markUpdaterProcess();
    mod.updateLog('rollback failed');
    // A file where the builds directory should be: mkdir and append both fail.
    const root = path.join(tmp, 'broken');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'builds'), 'not a directory');

    mod.flushUpdateLog(root);

    const leftovers = fs
      .readdirSync(tmp)
      .filter((f) => f.startsWith('quickord-update-'));
    expect(leftovers).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmp, leftovers[0]!), 'utf8')).toContain(
      'rollback failed'
    );
  });

  it('absorbs a dead updater log at boot and leaves a live one alone', () => {
    const builds = install(path.join(tmp, 'install'));
    const dead = path.join(tmp, 'quickord-update-999999.log');
    const live = path.join(tmp, `quickord-update-${process.pid}.log`);
    fs.writeFileSync(dead, 'updater died mid-copy\n');
    fs.writeFileSync(live, 'still running\n');

    const cwd = process.cwd();
    process.chdir(builds);
    try {
      load().mod.absorbStrayUpdateLogs();
    } finally {
      process.chdir(cwd);
    }

    expect(fs.readFileSync(path.join(builds, 'autoupdate.log'), 'utf8')).toBe(
      'updater died mid-copy\n'
    );
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('goes to the app log when it is not the updater', () => {
    const { logger, mod } = load();

    mod.updateLog('normal boot version check');

    expect(logger.info).toHaveBeenCalledWith('normal boot version check');
    expect(
      fs.readdirSync(tmp).filter((f) => f.startsWith('quickord-update-'))
    ).toHaveLength(0);
  });
});
