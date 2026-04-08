import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { exec } from 'node:child_process';

import nconf from 'nconf';

nconf.argv().env().file({ file: './config.json' });

function isLatestVersion(current: string, latest: string): boolean {
  const parse = (v: string) => {
    const [datePart = '', counterPart] = v.replace(/^v/, '').split('-');
    const nums = datePart.split('.').map((x) => parseInt(x, 10));
    const counter = counterPart ? parseInt(counterPart, 10) : 0;
    nums.push(counter);
    return nums;
  };

  const c = parse(current);
  const l = parse(latest);

  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const a = c[i] || 0;
    const b = l[i] || 0;
    if (a < b) return false;
    if (a > b) return true;
  }
  return true; // equal versions
}

async function fetchLatestReleaseVersion(): Promise<string | null> {
  const versionUrl = nconf.get('CODE_VERSION_URL');
  if (!versionUrl) {
    console.warn('CODE_VERSION_URL not configured. Skipping version check.');
    return null;
  }

  try {
    console.log('Fetching latest release info from:', versionUrl);

    const jsonData = await new Promise<string>((resolve, reject) => {
      const cmd = `curl -L -H "User-Agent: quickord-printer-server" "${versionUrl}"`;
      exec(cmd, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });

    const releaseData = JSON.parse(jsonData) as { tag_name?: string };
    const tagName = releaseData.tag_name;

    if (!tagName) {
      console.warn('No tag_name found in release data');
      return null;
    }

    console.log('Latest release version:', tagName);
    return tagName;
  } catch (err: any) {
    console.error('Error fetching latest release version:', err.message || err);
    return null;
  }
}

function launchUpdaterAndExit(): boolean {
  // updater.exe sits one level above builds/
  const cwd = process.cwd();
  const updaterPath = path.resolve(cwd, '..', 'updater.exe');

  if (!fs.existsSync(updaterPath)) {
    console.error('updater.exe not found at:', updaterPath);
    return false;
  }

  console.log('Launching updater:', updaterPath);

  const child = spawn('cmd.exe', ['/c', 'start', '', updaterPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });

  child.on('error', (err) => {
    console.error('Failed to launch updater:', err.message);
  });

  child.unref();

  console.log('Updater launched. Exiting printerServer...');
  setTimeout(() => {
    process.exit(0);
  }, 500);
  return true;
}

export default async function autoUpdate() {
  // Only run on Windows
  if (process.platform !== 'win32') {
    console.log('Skipping auto-update: non-Windows OS detected.');
    return;
  }

  // Read current version
  let currentVersion = '';
  try {
    currentVersion = (await fsp.readFile('version', 'utf-8')).trim();
    console.log('Current version:', currentVersion);
  } catch {
    console.log('No current version file found, assuming update needed.');
  }

  // Fetch latest version from GitHub
  const latestVersion = await fetchLatestReleaseVersion();

  if (!latestVersion) {
    console.log('Could not fetch latest version. Skipping update.');
    return;
  }

  if (isLatestVersion(currentVersion, latestVersion)) {
    console.log('Already up to date. No update needed.');
    console.log(`Current: ${currentVersion}, Latest: ${latestVersion}`);
    return;
  }

  console.log('Update available!');
  console.log(`Current: ${currentVersion} -> Latest: ${latestVersion}`);

  // Delegate to updater.exe and exit
  const launched = launchUpdaterAndExit();
  if (!launched) {
    console.error('Could not launch updater. Continuing without update.');
  }
}
