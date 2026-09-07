import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  clearFailedRelease,
  MAX_RELEASE_ATTEMPTS,
  noteFailedRelease,
  readFailedRelease,
} from '../src/autoupdate/autoupdate';

// The updater runs from the new build (its cwd holds the new `version`) and
// writes the marker into the install it is about to restart.
function makeDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-release-'));
  const installDir = path.join(root, 'install');
  const newBuild = path.join(root, 'new-build');
  fs.mkdirSync(path.join(installDir, 'builds'), { recursive: true });
  fs.mkdirSync(newBuild, { recursive: true });
  fs.writeFileSync(path.join(newBuild, 'version'), 'v2026.09.07-019300\n');
  return { installDir, newBuild, root };
}

describe('failed-release marker', () => {
  const cwd = process.cwd();
  let dirs: ReturnType<typeof makeDirs>;

  beforeEach(() => {
    dirs = makeDirs();
    process.chdir(dirs.newBuild);
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dirs.root, { force: true, recursive: true });
  });

  const builds = () => path.join(dirs.installDir, 'builds');

  it('counts the attempts per release', () => {
    noteFailedRelease(dirs.installDir);
    expect(readFailedRelease(builds())).toEqual({
      attempts: 1,
      version: 'v2026.09.07-019300',
    });

    noteFailedRelease(dirs.installDir);
    expect(readFailedRelease(builds())?.attempts).toBe(2);
  });

  it('restarts the count when a different release fails', () => {
    noteFailedRelease(dirs.installDir);
    noteFailedRelease(dirs.installDir);
    fs.writeFileSync(path.join(dirs.newBuild, 'version'), 'v2026.09.08-019301');

    noteFailedRelease(dirs.installDir);

    expect(readFailedRelease(builds())).toEqual({
      attempts: 1,
      version: 'v2026.09.08-019301',
    });
  });

  it('gives a release its retries before the boot check gives up', () => {
    for (let i = 0; i < MAX_RELEASE_ATTEMPTS; i += 1) {
      expect(readFailedRelease(builds())?.attempts ?? 0).toBeLessThan(
        MAX_RELEASE_ATTEMPTS
      );
      noteFailedRelease(dirs.installDir);
    }
    expect(readFailedRelease(builds())?.attempts).toBe(MAX_RELEASE_ATTEMPTS);
  });

  it('reads nothing from a missing or unreadable marker', () => {
    expect(readFailedRelease(builds())).toBeNull();
    fs.writeFileSync(path.join(builds(), 'failed-release.json'), 'not json');
    expect(readFailedRelease(builds())).toBeNull();
  });

  it('clears the marker', () => {
    noteFailedRelease(dirs.installDir);
    clearFailedRelease(builds());
    expect(readFailedRelease(builds())).toBeNull();
    // Clearing a marker that is not there is not an error.
    expect(() => clearFailedRelease(builds())).not.toThrow();
  });
});
