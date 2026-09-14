import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  clearFailedRelease,
  hasBootUpdateGuard,
  markBootUpdateGuard,
  MAX_RELEASE_ATTEMPTS,
  noteFailedRelease,
  overCapRelease,
  readFailedRelease,
  serviceXmlWithNoUpdate,
  suppressBootUpdates,
  xmlSuppressesUpdates,
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

  // The updater repeats the check because the install it rolls back to may be
  // older than the check itself and would otherwise re-download forever.
  describe('the updater-side check', () => {
    const overCap = () => overCapRelease(dirs.installDir, false);

    it('lets a release through until it has used up its attempts', () => {
      expect(overCap()).toBeNull();
      for (let i = 0; i < MAX_RELEASE_ATTEMPTS - 1; i += 1) {
        noteFailedRelease(dirs.installDir);
        expect(overCap()).toBeNull();
      }

      noteFailedRelease(dirs.installDir);
      expect(overCap()).toContain('v2026.09.07-019300');
    });

    it('only blocks the release the marker names', () => {
      for (let i = 0; i < MAX_RELEASE_ATTEMPTS; i += 1) {
        noteFailedRelease(dirs.installDir);
      }
      fs.writeFileSync(
        path.join(dirs.newBuild, 'version'),
        'v2026.09.08-019301'
      );

      expect(overCap()).toBeNull();
    });

    it('lets an explicit update past the cap', () => {
      for (let i = 0; i < MAX_RELEASE_ATTEMPTS; i += 1) {
        noteFailedRelease(dirs.installDir);
      }

      expect(overCapRelease(dirs.installDir, true)).toBeNull();
    });

    it('goes ahead when the new build has no version file', () => {
      for (let i = 0; i < MAX_RELEASE_ATTEMPTS; i += 1) {
        noteFailedRelease(dirs.installDir);
      }
      fs.rmSync(path.join(dirs.newBuild, 'version'));

      expect(overCap()).toBeNull();
    });
  });
});

// What has to happen once the cap has stopped the install: the machine is
// handed back to the old build, and that build must end up *serving*. Every
// pre-marker build checks for the update before it listens and exits 500 ms
// after spawning the updater, so restarting one with no arguments only feeds
// the loop the cap exists to break.
describe('handing the machine back after a capped release', () => {
  const cwd = process.cwd();
  let dirs: ReturnType<typeof makeDirs>;

  const SHIPPED_XML = fs.readFileSync('printerServerService.xml', 'utf-8');

  beforeEach(() => {
    dirs = makeDirs();
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dirs.root, { force: true, recursive: true });
  });

  const builds = () => path.join(dirs.installDir, 'builds');
  const writeXml = (xml: string) =>
    fs.writeFileSync(path.join(builds(), 'printerServerService.xml'), xml);
  const readXml = () =>
    fs.readFileSync(path.join(builds(), 'printerServerService.xml'), 'utf-8');

  it('starts the shipped service xml with updates off', () => {
    writeXml(SHIPPED_XML);

    expect(suppressBootUpdates(builds())).toBe(true);

    const xml = readXml();
    expect(xml).toContain('<arguments>--noupdate</arguments>');
    expect(xml).toContain('</service>');
    expect(xmlSuppressesUpdates(xml)).toBe(true);
  });

  it('does not stack the flag when the recovery runs again', () => {
    writeXml(SHIPPED_XML);
    suppressBootUpdates(builds());
    const once = readXml();

    expect(suppressBootUpdates(builds())).toBe(true);
    expect(readXml()).toBe(once);
  });

  it('keeps the arguments the install already had', () => {
    writeXml(
      SHIPPED_XML.replace(
        '</service>',
        '  <arguments>--port 7810</arguments>\n</service>'
      )
    );

    suppressBootUpdates(builds());

    expect(readXml()).toContain(
      '<arguments>--port 7810 --noupdate</arguments>'
    );
  });

  it('stays with the list form when the xml uses it', () => {
    writeXml(
      SHIPPED_XML.replace(
        '</service>',
        '  <argument>--port</argument>\n  <argument>7810</argument>\n</service>'
      )
    );

    suppressBootUpdates(builds());

    const xml = readXml();
    expect(xml).toContain('<argument>--noupdate</argument>');
    expect(xml).not.toContain('<arguments>');
    expect(xmlSuppressesUpdates(xml)).toBe(true);
  });

  it('refuses to edit a file that is not a service xml', () => {
    expect(serviceXmlWithNoUpdate('not xml at all')).toBeNull();
    writeXml('not xml at all');
    expect(suppressBootUpdates(builds())).toBe(false);
  });

  it('reports a missing xml instead of throwing', () => {
    expect(suppressBootUpdates(builds())).toBe(false);
  });

  // Which recovery the updater picks. A build that reads the marker refuses the
  // release on its own and must keep its update check, or it would never take
  // the release that fixes it.
  it('tells a self-protecting install from one that loops', () => {
    expect(hasBootUpdateGuard(dirs.installDir)).toBe(false);

    process.chdir(builds());
    markBootUpdateGuard();
    process.chdir(cwd);

    expect(hasBootUpdateGuard(dirs.installDir)).toBe(true);
  });

  it('leaves a serving instance for an install that predates the marker', () => {
    writeXml(SHIPPED_XML);
    process.chdir(dirs.newBuild);
    for (let i = 0; i < MAX_RELEASE_ATTEMPTS; i += 1) {
      noteFailedRelease(dirs.installDir);
    }

    // The updater aborts, and because the install cannot refuse the release
    // itself, it goes back up without its boot-time update check.
    expect(overCapRelease(dirs.installDir, false)).toContain(
      'v2026.09.07-019300'
    );
    expect(hasBootUpdateGuard(dirs.installDir)).toBe(false);
    expect(suppressBootUpdates(builds())).toBe(true);

    // That is the whole point: the next start reaches app.listen() instead of
    // downloading the same release, handing off and exiting.
    expect(xmlSuppressesUpdates(readXml())).toBe(true);
  });
});
