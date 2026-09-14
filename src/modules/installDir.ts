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
if (process.platform === 'win32' && !process.argv[1]?.endsWith('.ts')) {
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
