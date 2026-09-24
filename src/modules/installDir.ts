import path from 'path';

// settings.json, config.json, version and the install dir the updater derives
// from cwd are all read relative to the working directory, so a launch from
// anywhere else (a technician's cmd prompt) has the server write a fresh
// default settings.json there and point the next update at the wrong tree.
// The exe's own folder is the install: pin the cwd to it instead of trusting
// every launcher to set it.
//
// Imported for this side effect, and imported first: three modules load
// ./config.json at import time.

/**
 * Only the nexe binary's own folder is an install. tsx, jest and
 * `node dist/...` (init.bat, start:ci) all run under node.exe, whose folder is
 * Node's installation — pinning there would make the server read and write
 * its files in C:\Program Files\nodejs.
 */
export function isPackagedExe(execPath: string): boolean {
  // win32: this only matters on Windows, and it keeps the check testable
  // from a posix host, where path.basename does not split on backslashes.
  const execName = path.win32.basename(execPath).toLowerCase();
  return execName !== 'node' && execName !== 'node.exe';
}

if (process.platform === 'win32' && isPackagedExe(process.execPath)) {
  // nexe keeps process.execPath on the real binary; __dirname points inside it.
  const installDir = path.dirname(process.execPath);
  if (path.resolve(process.cwd()) !== path.resolve(installDir)) {
    try {
      process.chdir(installDir);
      console.log(`Working directory pinned to the install dir: ${installDir}`);
    } catch (err) {
      console.error(`Could not switch to the install dir ${installDir}:`, err);
    }
  }
}
