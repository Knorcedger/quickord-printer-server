/* eslint-disable no-continue */
/* eslint-disable default-param-last */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */

import * as fs from 'node:fs';
import { createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn, exec } from 'node:child_process';
import * as path from 'node:path';
import JSZip from 'jszip';

import nconf from 'nconf';
import {
  curlExec,
  curlExecJson,
  httpStatusError,
  tryFetchWithFallback,
} from '../modules/http';

nconf.argv().env().file({ file: './config.json' });
let path2 = '';
let args = ['--update', 'test'];
let destDir = '../';

const tempDirPath = `${tmpdir()}${sep}quickord-cashier-server-update`;
let srcDir = '';

async function extractZip(zipBuffer, tempCodePath) {
  const zip = await JSZip.loadAsync(zipBuffer);

  for (const [filename, entry] of Object.entries(zip.files)) {
    const fullPath = `${tempCodePath}${sep}${filename}`;

    if (entry.dir) {
      await fsp.mkdir(fullPath, { recursive: true });
    } else {
      await fsp.mkdir(dirname(fullPath), { recursive: true });
      const content = await entry.nodeStream();
      const writeStream = createWriteStream(fullPath);
      await pipeline(content, writeStream);
    }
  }
}

export async function copyOnlyFiles(
  srcDir: string,
  destDir: string,
  options: {
    ignoreFolders?: string[];
    skipNestedNodeModules?: boolean;
  } = {}
): Promise<void> {
  const { ignoreFolders = ['snapshot'], skipNestedNodeModules = true } =
    options;
  const ignored = new Set(ignoreFolders);

  await fs.promises.rm(destDir, { recursive: true, force: true });
  await fs.promises.mkdir(destDir, { recursive: true });

  function isNestedBuildsPath(filepath: string): boolean {
    const relativePath = path.relative(srcDir, filepath);
    const segments = relativePath.split(path.sep);
    return segments.filter((seg) => seg === 'builds').length > 1;
  }

  async function walk(currentDir: string) {
    const entries = await fs.promises.readdir(currentDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const entrySrcPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(srcDir, entrySrcPath);
      const entryDestPath = path.join(destDir, relativePath);

      // Skip explicitly ignored folders
      if (entry.isDirectory() && ignored.has(entry.name)) {
        console.log(`🚫 Ignoring folder: ${relativePath}`);
        continue;
      }

      // Skip deeply nested node_modules inside builds
      if (
        skipNestedNodeModules &&
        entry.isDirectory() &&
        entry.name === 'node_modules' &&
        isNestedBuildsPath(entrySrcPath)
      ) {
        console.log(`🚫 Skipping nested node_modules: ${relativePath}`);
        continue;
      }

      if (entry.isDirectory()) {
        await fs.promises.mkdir(entryDestPath, { recursive: true });
        await walk(entrySrcPath);
      } else if (entry.isFile()) {
        await fs.promises.copyFile(entrySrcPath, entryDestPath);
        console.log(`✅ Copied: ${relativePath}`);
      }
    }
  }

  await walk(srcDir);
  console.log('🎉 Copy completed.');
}
export function launchDetached(appPath: string, args: string[]): boolean {
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', appPath, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    child.unref();
    return true;
  } catch (err) {
    console.error('Failed to relaunch exe:', err);
    return false;
  }
}

export async function relaunchExe(
  appPath: string,
  args: string[],
  exitDelayMs = 500
) {
  if (!launchDetached(appPath, args)) return;

  console.log('Relaunched exe with args. Waiting to exit...');

  // The delay lets the child get off the ground before this process dies. On
  // the remote-update path it also has to outlast the HTTP result report to
  // the backend, hence the caller-tunable value.
  setTimeout(() => {
    process.exit(0);
  }, exitDelayMs);
}

// ---------------------------------------------------------------------------
// Windows service control
//
// The update chain used to hand the running process off with detached spawns
// and never touch the SCM, which left the printer server alive but orphaned
// (service Stopped, exe still holding the port) after *every* update. These
// helpers make the chain go through the service manager and, crucially, check
// what it actually did instead of swallowing the exit code.
// ---------------------------------------------------------------------------

export const SERVICE_NAME = 'printerServer';

export type ServiceState = 'RUNNING' | 'STOPPED' | 'PENDING' | 'ABSENT' | 'UNKNOWN';

function runCmd(
  cmd: string,
  timeoutMs = 30_000
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as any).code ?? 1) : 0,
        output: `${stdout ?? ''}\n${stderr ?? ''}`,
      });
    });
  });
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export async function getServiceState(): Promise<ServiceState> {
  const { code, output } = await runCmd(`sc.exe query ${SERVICE_NAME}`, 15_000);
  if (/1060/.test(output)) return 'ABSENT'; // service does not exist
  if (code !== 0) return 'UNKNOWN';
  if (/STATE\s*:\s*\d+\s+RUNNING/i.test(output)) return 'RUNNING';
  if (/STATE\s*:\s*\d+\s+STOPPED/i.test(output)) return 'STOPPED';
  if (/STATE\s*:\s*\d+\s+\w+_PENDING/i.test(output)) return 'PENDING';
  return 'UNKNOWN';
}

async function waitForState(
  wanted: ServiceState[],
  timeoutMs: number
): Promise<ServiceState> {
  const deadline = Date.now() + timeoutMs;
  let state = await getServiceState();
  while (!wanted.includes(state) && Date.now() < deadline) {
    await sleep(1000);
    state = await getServiceState();
  }
  return state;
}

// PIDs listening on `port`, excluding our own. netstat is parsed in JS rather
// than piped through findstr so a missing match isn't an error exit code.
async function findPortHolders(port: number): Promise<number[]> {
  const { output } = await runCmd('netstat -ano -p TCP', 20_000);
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[1] ?? '';
    if (!local.endsWith(`:${port}`)) continue;
    const pid = parseInt(parts[parts.length - 1] ?? '', 10);
    if (!Number.isFinite(pid) || pid === 0 || pid === process.pid) continue;
    pids.add(pid);
  }
  return [...pids];
}

/**
 * Stop the service and make sure nothing is left holding the server port.
 *
 * Killing by image name is not an option here: the updater *is* a
 * printerServer.exe (running from temp), so `taskkill /IM printerServer.exe`
 * would kill the updater itself. Only the port holder is killed, by PID.
 *
 * Returns false when the machine is not in a safe state to overwrite the
 * install directory — the caller must then abort *before* deleting anything.
 */
export async function stopServiceAndFreePort(port: number): Promise<boolean> {
  const initial = await getServiceState();
  console.log(`Service state before stop: ${initial}`);

  if (initial !== 'ABSENT' && initial !== 'STOPPED') {
    const { code, output } = await runCmd(`sc.exe stop ${SERVICE_NAME}`, 30_000);
    // 1062 = service not started. Anything else non-zero (5 = access denied
    // when force_autoupdate.bat runs unelevated) is worth surfacing, but the
    // state poll below is what actually decides.
    if (code !== 0) {
      console.error(`sc stop returned ${code}: ${output.trim()}`);
    }
    const state = await waitForState(['STOPPED', 'ABSENT'], 45_000);
    if (state !== 'STOPPED' && state !== 'ABSENT') {
      console.error(
        `Service did not reach Stopped (state: ${state}). Aborting update to avoid a half-copied install.`
      );
      return false;
    }
  }

  // Orphan healing: a service-less printerServer.exe (left behind by an older
  // build's detached relaunch) still owns the port and still locks its files.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const holders = await findPortHolders(port);
    if (holders.length === 0) return true;
    if (Date.now() > deadline) {
      console.error(
        `Port ${port} still held by PID(s) ${holders.join(', ')} after kill attempts. Aborting update.`
      );
      return false;
    }
    for (const pid of holders) {
      console.log(`Killing stale process ${pid} holding port ${port}`);
      await runCmd(`taskkill /PID ${pid} /F /T`, 15_000);
    }
    await sleep(1000);
  }
}

/**
 * Start the service and confirm it actually reached Running. Falls back to
 * launching the exe directly only if the SCM refuses (service missing, or no
 * privileges — force_autoupdate.bat runs as the technician, not LocalSystem),
 * so a failed `sc start` can never leave the venue with nothing running.
 */
export async function startServiceOrFallback(installDir: string): Promise<boolean> {
  const { code, output } = await runCmd(`sc.exe start ${SERVICE_NAME}`, 30_000);
  // 1056 = already running.
  if (code !== 0 && !/1056/.test(output)) {
    console.error(`sc start returned ${code}: ${output.trim()}`);
  }

  const state = await waitForState(['RUNNING'], 45_000);
  if (state === 'RUNNING') {
    console.log('Service is running.');
    return true;
  }

  console.error(
    `Service did not reach Running (state: ${state}). Falling back to a direct launch.`
  );
  const exe = path.join(path.resolve(installDir), 'builds', 'printerServer.exe');
  return launchDetached(exe, []);
}

/**
 * Detached safety net for a restart: a few seconds after we exit, make sure the
 * service is up again.
 *
 * It covers the two cases the exit code alone cannot. If we were orphaned, no
 * WinSW is watching us and `sc start` is what brings the machine back under the
 * SCM — the same call heals the orphan. If we were service-managed but the
 * on-disk xml is still the pre-onfailure one (a venue that has not taken the
 * update carrying the new xml yet), WinSW treats even a non-zero exit as the
 * end of the service; the watchdog starts it again. On an already-running
 * service `sc start` fails with 1056 and changes nothing.
 *
 * Written as a batch file rather than an inline `cmd /c` string because the
 * `find "RUNNING"` quoting does not survive Node's argument escaping.
 */
export function scheduleServiceStartWatchdog(): void {
  if (process.platform !== 'win32') return;
  try {
    const batPath = path.join(tmpdir(), 'quickord-restart-watchdog.bat');
    const exe = process.execPath;
    fs.writeFileSync(
      batPath,
      [
        '@echo off',
        'ping -n 9 127.0.0.1 >nul',
        `sc start ${SERVICE_NAME} >nul 2>&1`,
        'ping -n 6 127.0.0.1 >nul',
        `sc query ${SERVICE_NAME} | find "RUNNING" >nul`,
        `if errorlevel 1 start "" "${exe}"`,
        '',
      ].join('\r\n'),
      'utf-8'
    );
    const child = spawn('cmd.exe', ['/c', batPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (err: any) {
    console.error('Failed to schedule the service-start watchdog:', err.message || err);
  }
}

/**
 * Are we running as a child of WinSW, i.e. can the SCM restart us?
 *
 * Only then does exiting non-zero mean "restart me". An orphaned instance that
 * exits is simply gone, so restartServer() needs to know which world it is in.
 * Failing closed (false) is the safe answer: the caller's fallback is a
 * detached `sc start`, which is a no-op on an already-running service.
 */
export async function isServiceManaged(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const ppid = process.ppid;
  if (!ppid) return false;
  const { code, output } = await runCmd(
    `powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${ppid}').Name"`,
    15_000
  );
  if (code !== 0) return false;
  return /printerServerService\.exe/i.test(output);
}
export async function deleteFolderRecursive(
  folderPath: string,
  silent: boolean = false
): Promise<void> {
  try {
    const entries = await fsp.readdir(folderPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name);

      if (entry.isDirectory()) {
        await deleteFolderRecursive(fullPath, silent); // recursive for subfolders
      } else {
        await fsp.unlink(fullPath); // delete file
      }
    }

    await fsp.rmdir(folderPath); // remove empty folder
    if (!silent) {
      console.log(`Deleted: ${folderPath}`);
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      if (!silent) {
        console.warn(`Folder does not exist: ${folderPath}`);
      }
    } else {
      if (!silent) {
        console.error(`Error deleting ${folderPath}:`, err.message || err);
      }
    }
  }
}

function isLatestVersion(current, latest) {
  const parse = (v) => {
    const [datePart, counterPart] = v.replace(/^v/, '').split('-');
    const nums = datePart.split('.').map((x) => parseInt(x, 10));
    const counter = counterPart ? parseInt(counterPart, 10) : 0;
    nums.push(counter); // add counter as last number
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

    const result = await tryFetchWithFallback<{ tag_name?: string }>({
      url: versionUrl,
      method: 'GET',
      fetchFn: async () => {
        const response = await fetch(versionUrl, {
          redirect: 'follow',
          headers: { 'User-Agent': 'quickord-printer-server' },
        });
        if (!response.ok) throw httpStatusError(response);
        return { data: (await response.json()) as { tag_name?: string } };
      },
      curlFn: () =>
        curlExecJson(
          `curl -L -H "User-Agent: quickord-printer-server" "${versionUrl}"`
        ),
    });
    const releaseData = result.data;
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

export interface UpdateCheckResult {
  currentVersion?: string;
  error?: string;
  latestVersion?: string;
  state: 'already-latest' | 'updating' | 'failed';
}

export async function downloadLatestCode(
  relaunchDelayMs = 500
): Promise<UpdateCheckResult> {
  // Read current version
  let currentVersion = '';
  try {
    currentVersion = (await fsp.readFile('version', 'utf-8')).trim();
    console.log('Current version:', currentVersion);
  } catch {
    console.log('No current version file found, assuming update needed.');
  }

  // Fetch latest version from GitHub API (without downloading)
  const latestVersion = await fetchLatestReleaseVersion();

  if (latestVersion) {
    // Compare versions before downloading
    if (isLatestVersion(currentVersion, latestVersion)) {
      console.log('Already up to date. No download needed.');
      console.log(`Current: ${currentVersion}, Latest: ${latestVersion}`);
      return { currentVersion, latestVersion, state: 'already-latest' };
    }
    console.log('Update available!');
    console.log(`Current: ${currentVersion} -> Latest: ${latestVersion}`);
  } else {
    console.log(
      'Could not fetch latest version from API (network not ready?). Skipping update.'
    );
    return {
      currentVersion,
      error: 'Could not fetch the latest version',
      state: 'failed',
    };
  }

  // Proceed with download
  const url = nconf.get('CODE_UPDATE_URL');
  console.log('Starting download from:', url);

  const srcDir = await fsp.mkdtemp(tempDirPath);
  const zipPath = path.resolve(srcDir, 'quickord-cashier-server.zip');

  await tryFetchWithFallback<void>({
    url,
    method: 'GET',
    fetchFn: async () => {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok || !response.body) throw httpStatusError(response);
      await pipeline(response.body, createWriteStream(zipPath));
      return { data: undefined as void };
    },
    curlFn: async () => {
      await curlExec(`curl -L "${url}" -o "${zipPath}"`);
    },
  });

  // Extract zip
  const tempCodePath = path.resolve(srcDir, 'code');
  await fsp.mkdir(tempCodePath, { recursive: true });
  const zipBuffer = await fsp.readFile(zipPath);
  await extractZip(zipBuffer, tempCodePath);

  console.log('Update needed. Code ready at:', tempCodePath);
  console.log('Updating to latest version');
  console.log(tempCodePath);
  const cwd = process.cwd();
  const parentDir = path.resolve(cwd, '..');

  args[1] = tempCodePath;
  args[2] = '--parent';
  args[3] = parentDir;
  path2 = tempCodePath + '/builds/printerServer.exe';
  relaunchExe(path2, args, relaunchDelayMs);
  return { currentVersion, latestVersion, state: 'updating' };
}

// Update trigger registered by index.ts, mirroring setRestartHandler. Lets the
// WS/pull control channels ask for an explicit version check without going
// through a restart — when there is nothing new, the server keeps running.
let updateHandler: (() => Promise<UpdateCheckResult>) | null = null;

export function setUpdateHandler(fn: () => Promise<UpdateCheckResult>): void {
  updateHandler = fn;
}

export async function triggerUpdate(): Promise<UpdateCheckResult> {
  if (!updateHandler) {
    return { error: 'No update handler registered', state: 'failed' };
  }
  try {
    return await updateHandler();
  } catch (err: any) {
    return { error: err?.message || String(err), state: 'failed' };
  }
}

/**
 * The update chain unpacks each release into %TMP%\quickord-cashier-server-update*
 * and the updater that runs from there cannot delete its own directory. The
 * freshly installed server does it instead, on the next boot — this replaces
 * the old `--remove` hop, which was the reason a post-update process carried
 * `--remove` args and silently skipped its version check on every restart.
 */
export async function sweepTempUpdateDirs(): Promise<void> {
  if (process.platform !== 'win32') return;
  const base = tmpdir();
  const entries = await fsp.readdir(base).catch(() => [] as string[]);
  const cwd = path.resolve(process.cwd()).toLowerCase();

  for (const name of entries) {
    if (!name.startsWith('quickord-cashier-server-update')) continue;
    const full = path.join(base, name);
    // Never delete the tree we are currently running from.
    if (cwd.startsWith(full.toLowerCase())) continue;
    await safeCleanup(full);
  }
}

export async function safeCleanup(dirPath: string) {
  try {
    const resolvedPath = path.resolve(dirPath);
    const stat = await fsp.stat(resolvedPath).catch(() => null);
    if (!stat) return; // folder doesn't exist

    // Tiny delay to ensure all streams are closed
    await new Promise((res) => setTimeout(res, 50));

    await fsp.rm(resolvedPath, { recursive: true, force: true });
    console.log('✅ Temp folder cleaned up:', resolvedPath);
  } catch (err: any) {
    console.error('⚠️ Failed to clean temp folder:', err.message);
  }
}

export async function copyRecursive(
  sourceFolder: string,
  destFolder: string
): Promise<void> {
  if (!fs.existsSync(sourceFolder)) {
    throw new Error(`Source folder does not exist: ${sourceFolder}`);
  }

  if (!fs.existsSync(destFolder)) {
    fs.mkdirSync(destFolder, { recursive: true });
  }

  const entries = fs.readdirSync(sourceFolder, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceFolder, entry.name);
    const destPath = path.join(destFolder, entry.name);

    if (entry.isDirectory()) {
      await copyRecursive(sourcePath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destPath);
    }
  }
}

export function copyWithCmd(
  sourceFolder: string,
  destFolder: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const src = path.resolve(sourceFolder);
    const dest = path.resolve(destFolder);

    const command = `xcopy "${src}" "${dest}" /E /I /Y`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error: ${stderr}`);
        return reject(error);
      }
      console.log(stdout);
      resolve(undefined);
    });
  });
}

function applyServiceConfig(): Promise<void> {
  return new Promise((resolve) => {
    const cmd =
      'sc.exe config printerServer start= delayed-auto depend= Tcpip/Dnscache/NlaSvc';
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to apply service config:', stderr || error.message);
      } else {
        console.log('Service config applied:', stdout.trim());
      }
      resolve();
    });
  });
}

function copySettingsFile(settingsPath, destDir) {
  return new Promise((resolve, reject) => {
    const command = `xcopy "${settingsPath}" "${path.join(destDir, 'builds')}\\" /Y`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error copying settings: ${stderr}`);
        return reject(error);
      }
      console.log('Settings file copied with xcopy.');
      resolve(undefined);
    });
  });
}
export default async function autoUpdate(path: string[]) {
  console.log('AutoUpdate path:', path);
  // Check if running on Windows
  if (process.platform !== 'win32') {
    console.log('Skipping auto-update: non-Windows OS detected.');
    return;
  }

  if (path.length === 0) {
    await downloadLatestCode();
    return;
  }

  if (path[0] === '--update') {
    await runUpdater(path);
    // This process is the updater, not a server: it runs from %TMP% and the
    // real instance is already back up under the service manager. Falling
    // through to main() would bind the port from the temp copy.
    process.exit(0);
  }
}

/**
 * The `--update` mode: replace the install directory and hand control back to
 * the service manager. Runs from the freshly downloaded copy in %TMP%, so it is
 * free to overwrite the install underneath it.
 */
async function runUpdater(path: string[]): Promise<void> {
  srcDir = path[1]?.toString() || '';
  destDir = path[3]?.toString() || '';
  console.log(`srcDir: ${srcDir}`);
  console.log(`destDir: ${destDir}`);
  process.chdir(srcDir + '\\builds');

  const port = Number(nconf.get('PORT')) || 7810;

  // Stop the service (and any orphan holding the port) BEFORE touching the
  // install dir. If that fails, the old install is still intact and running —
  // far better than a half-copied directory with the service down.
  if (!(await stopServiceAndFreePort(port))) {
    console.error('Update aborted: could not free the install directory.');
    await startServiceOrFallback(destDir);
    return;
  }

  // settings.json is the only per-venue state in the install dir. Losing it
  // means a venue with no printers configured, so a failed backup aborts the
  // update instead of deleting anything.
  const settingsPath = `${destDir}\\builds\\settings.json`;
  if (fs.existsSync(settingsPath)) {
    try {
      await copySettingsFile(settingsPath, srcDir);
    } catch (err: any) {
      console.error(
        'Update aborted: failed to back up settings.json:',
        err.message || err
      );
      await startServiceOrFallback(destDir);
      return;
    }
  } else {
    console.warn(`No settings.json at ${settingsPath}, nothing to preserve.`);
  }

  try {
    await deleteFolderRecursive(destDir);
    await fsp.mkdir(destDir, { recursive: true });
    console.log('paths: ', srcDir, destDir);
    await copyWithCmd(srcDir, destDir);
  } catch (err: any) {
    // Nothing to roll back to at this point; the best move is still to get
    // the service up so the next boot can retry the update.
    console.error('Copy of the new build failed:', err.message || err);
  }

  await applyServiceConfig();
  await startServiceOrFallback(destDir);
  // The temp folder is left behind on purpose: this process lives in it. The
  // newly started server sweeps it on boot (sweepTempUpdateDirs).
}
