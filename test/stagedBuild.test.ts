import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  noteFailedRelease,
  readFailedRelease,
  validateStagedBuild,
} from '../src/autoupdate/autoupdate';

// A staged release as extractZip leaves it: builds/ next to node_modules/.
function makeStaged(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-build-'));
  const builds = path.join(root, 'builds');
  fs.mkdirSync(builds, { recursive: true });
  for (const f of [
    'printerServer.exe',
    'printerServerService.exe',
    'config.json',
    'version',
  ]) {
    fs.writeFileSync(path.join(builds, f), 'x');
  }
  fs.mkdirSync(path.join(root, 'node_modules', 'serialport'), {
    recursive: true,
  });
  return root;
}

describe('validateStagedBuild', () => {
  let staged: string;

  beforeEach(() => {
    staged = makeStaged();
  });

  afterEach(() => {
    fs.rmSync(staged, { force: true, recursive: true });
  });

  it('accepts a complete release', () => {
    expect(validateStagedBuild(staged)).toBeNull();
  });

  // The regression: the exe resolves its native modules from <install>/
  // node_modules, so a zip without it dies in require() — and because the
  // updater *is* that exe, the handoff leaves nothing running at all.
  it('rejects a release with no node_modules', () => {
    fs.rmSync(path.join(staged, 'node_modules'), { recursive: true });
    expect(validateStagedBuild(staged)).toMatch(/node_modules/);
  });

  it('rejects a release with an empty node_modules', () => {
    fs.rmSync(path.join(staged, 'node_modules', 'serialport'), {
      recursive: true,
    });
    expect(validateStagedBuild(staged)).toMatch(/node_modules/);
  });

  it.each([
    'printerServer.exe',
    'printerServerService.exe',
    'config.json',
    'version',
  ])('rejects a release with no builds/%s', (file) => {
    fs.rmSync(path.join(staged, 'builds', file));
    expect(validateStagedBuild(staged)).toBe(
      `the release is missing builds/${file}`
    );
  });

  // The zip never extracted where we think it did.
  it('rejects a staging directory that does not exist', () => {
    expect(validateStagedBuild(path.join(staged, 'nope'))).not.toBeNull();
  });
});

// The boot check matches the marker on the tag it got from the releases API, so
// the caller that only knows the tag has to be able to say so: the updater
// child reads the version out of the build it runs from, but a build that never
// starts leaves nobody to do that.
describe('noteFailedRelease with an explicit version', () => {
  let root: string;
  let installDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-failed-'));
    installDir = path.join(root, 'install');
    fs.mkdirSync(path.join(installDir, 'builds'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  it('counts attempts against the version it is given', () => {
    const builds = path.join(installDir, 'builds');
    noteFailedRelease(installDir, 'v2026.09.16-019215');
    expect(readFailedRelease(builds)).toEqual({
      attempts: 1,
      version: 'v2026.09.16-019215',
    });

    noteFailedRelease(installDir, 'v2026.09.16-019215');
    expect(readFailedRelease(builds)?.attempts).toBe(2);
  });

  it('restarts the count for a different version', () => {
    const builds = path.join(installDir, 'builds');
    noteFailedRelease(installDir, 'v2026.09.16-019215');
    noteFailedRelease(installDir, 'v2026.09.17-019216');
    expect(readFailedRelease(builds)).toEqual({
      attempts: 1,
      version: 'v2026.09.17-019216',
    });
  });
});
