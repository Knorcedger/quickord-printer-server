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
  HttpResult,
  tryFetchWithFallback,
} from '../modules/http';
import { reportFetchFailure } from '../modules/api';
import {
  flushUpdateLog,
  markUpdaterProcess,
  updateLog,
  updateLogError,
} from './updateLog';
import {
  parseListeningPids,
  parseScQueryState,
  parseServiceStatusName,
  type ServiceState,
} from './serviceState';

// The update path uses tryFetchWithFallback exactly like the runtime paths
// (poll/apiCall/common) but never looked at viaFallback, so a fetch that failed
// and only succeeded via the curl fallback went unreported here. Mirror the
// runtime wiring: when the update download/version check falls back to curl,
// report it so a fetch that is quietly broken on the update path is visible too.
// Fire-and-forget, same as the runtime call sites; a report failure must never
// hold up or break an update.
function reportIfViaFallback<T>(result: HttpResult<T>): void {
  if (result.viaFallback && result.fetchFailure) {
    reportFetchFailure(result.fetchFailure).catch(() => {});
  }
}

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

/**
 * Recursive delete that works inside the nexe exe.
 *
 * `fs.rm({ recursive: true })` goes through node's `internal/fs/rimraf`, which
 * calls `readdir(path, 'buffer')` and concatenates the returned Buffers. nexe
 * patches fs for its virtual filesystem and ignores that encoding, so rimraf
 * gets strings back and throws `ERR_INVALID_ARG_TYPE` from `Buffer.concat` —
 * *inside a callback*, so it surfaces as an unhandled rejection that no
 * try/catch around the `rm()` can see. Walking the tree ourselves with the
 * plain (string) readdir keeps every delete on the update path survivable.
 */
export async function rmrf(target: string): Promise<void> {
  const stat = await fsp.lstat(target).catch((err: any) => {
    if (err?.code === 'ENOENT') return null;
    throw err;
  });
  if (!stat) return;

  // Read-only files are common in an extracted release; rimraf's own EPERM
  // handling (chmod, then retry) is the part worth keeping.
  const withWinEperm = async (op: () => Promise<void>) => {
    try {
      await op();
    } catch (err: any) {
      if (err?.code !== 'EPERM') throw err;
      await fsp.chmod(target, 0o666).catch(() => {});
      await op();
    }
  };

  if (!stat.isDirectory()) {
    await withWinEperm(() => fsp.unlink(target));
    return;
  }

  const entries = await fsp.readdir(target);
  for (const name of entries) {
    await rmrf(path.join(target, name));
  }
  await withWinEperm(() => fsp.rmdir(target));
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

  await rmrf(destDir);
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
        updateLog(`🚫 Ignoring folder: ${relativePath}`);
        continue;
      }

      // Skip deeply nested node_modules inside builds
      if (
        skipNestedNodeModules &&
        entry.isDirectory() &&
        entry.name === 'node_modules' &&
        isNestedBuildsPath(entrySrcPath)
      ) {
        updateLog(`🚫 Skipping nested node_modules: ${relativePath}`);
        continue;
      }

      if (entry.isDirectory()) {
        await fs.promises.mkdir(entryDestPath, { recursive: true });
        await walk(entrySrcPath);
      } else if (entry.isFile()) {
        await fs.promises.copyFile(entrySrcPath, entryDestPath);
        updateLog(`✅ Copied: ${relativePath}`);
      }
    }
  }

  await walk(srcDir);
  updateLog('🎉 Copy completed.');
}
/**
 * `cwd` matters more than it looks: the server reads and writes its runtime
 * files relative to the working directory (`./config.json`, `version`,
 * `./settings.json`). The updater runs from %TMP%, so a launch that inherits
 * its cwd would start the installed exe pointing at the temp copy's config.
 * Callers that launch an *installed* exe must pass its own directory.
 */
export function launchDetached(
  appPath: string,
  args: string[],
  cwd?: string
): boolean {
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', appPath, ...args], {
      cwd: cwd ?? path.dirname(appPath),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    child.unref();
    return true;
  } catch (err) {
    updateLogError('Failed to relaunch exe:', err);
    return false;
  }
}

// Work that must land before this process exits on the update path — the
// on-demand update's result report to the backend. A fixed delay alone loses
// it on a slow link, and the backend then has no answer for a command whose
// whole point is the answer.
const preExitTasks = new Set<Promise<unknown>>();
const PRE_EXIT_CAP_MS = 15_000;

export function registerPreExitTask(task: Promise<unknown>): void {
  preExitTasks.add(task);
  void task.catch(() => {}).finally(() => preExitTasks.delete(task));
}

// A running .exe cannot be opened for writing on Windows — from the outside,
// that lock is the only proof a launched process is really up.
function isExeLocked(exe: string): boolean {
  try {
    fs.closeSync(fs.openSync(exe, 'r+'));
    return false;
  } catch (err: any) {
    return ['EBUSY', 'EPERM', 'EACCES'].includes(err?.code);
  }
}

async function waitForExeLock(
  exe: string,
  timeoutMs = 15_000
): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isExeLocked(exe)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

/** Relaunch and exit — returns false when the child never came up, so we stay. */
export async function relaunchExe(
  appPath: string,
  args: string[],
  exitDelayMs = 500
): Promise<boolean> {
  if (!launchDetached(appPath, args)) return false;

  // `cmd /c start` exits 0 even when it could not launch the exe (AV lock,
  // Smart App Control, a swept temp tree). Exiting on that alone stops the
  // service with no updater to bring it back, so wait for the child's lock.
  if (!(await waitForExeLock(appPath))) {
    updateLogError(
      `Launched ${appPath} but no process ever took it; staying up instead of exiting.`
    );
    return false;
  }

  updateLog('Relaunched exe with args. Waiting to exit...');

  // The delay lets the child get off the ground before this process dies. On
  // the remote-update path it also has to outlast the HTTP result report to
  // the backend — that one is awaited explicitly (capped, so a backend that
  // never answers cannot keep the old exe alive forever).
  setTimeout(async () => {
    if (preExitTasks.size > 0) {
      updateLog(
        `Waiting for ${preExitTasks.size} pending report(s) before exit.`
      );
      await Promise.race([
        Promise.allSettled([...preExitTasks]),
        sleep(PRE_EXIT_CAP_MS),
      ]);
    }
    process.exit(0);
  }, exitDelayMs);
  return true;
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

export type { ServiceState };

function runCmd(
  cmd: string,
  timeoutMs = 30_000
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    exec(
      cmd,
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as any).code ?? 1) : 0,
          output: `${stdout ?? ''}\n${stderr ?? ''}`,
        });
      }
    );
  });
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// sc.exe prints localized field labels and state words, so nothing may key off
// them: on a Greek install `STATE : 4  RUNNING` simply is not there. Get-Service
// returns a .NET enum name, which is invariant in every locale; sc.exe's
// (unlocalized) numeric state is the fallback when PowerShell is unavailable.
const SERVICE_STATUS_PS = `powershell -NoProfile -NonInteractive -Command "$s = Get-Service -Name '${SERVICE_NAME}' -ErrorAction SilentlyContinue; if ($s) { $s.Status.ToString() } else { 'Absent' }"`;

export async function getServiceState(): Promise<ServiceState> {
  const ps = await runCmd(SERVICE_STATUS_PS, 20_000);
  if (ps.code === 0) {
    const state = parseServiceStatusName(ps.output);
    if (state) return state;
  }
  const sc = await runCmd(`sc.exe query ${SERVICE_NAME}`, 15_000);
  return parseScQueryState(sc.output, sc.code);
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
// than piped through findstr so a missing match isn't an error exit code. The
// state column is localized, so a listener is recognised by its wildcard
// foreign address instead of the word LISTENING.
export async function findPortHolders(port: number): Promise<number[]> {
  const { output } = await runCmd('netstat -ano -p TCP', 20_000);
  return parseListeningPids(output, port, process.pid);
}

/** Kill everything listening on `port` (never ourselves); returns the PIDs. */
export async function killPortHolders(port: number): Promise<number[]> {
  const holders = await findPortHolders(port);
  for (const pid of holders) {
    await runCmd(`taskkill /PID ${pid} /F /T`, 15_000);
  }
  return holders;
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
  updateLog(`Service state before stop: ${initial}`);

  if (initial !== 'ABSENT' && initial !== 'STOPPED') {
    const { code, output } = await runCmd(
      `sc.exe stop ${SERVICE_NAME}`,
      30_000
    );
    // 1062 = service not started. Anything else non-zero (5 = access denied
    // when force_autoupdate.bat runs unelevated) is worth surfacing, but the
    // state poll below is what actually decides.
    if (code !== 0) {
      updateLogError(
        `sc stop returned ${code}: ${describeScError(code, output)}`
      );
    }
    const state = await waitForState(['STOPPED', 'ABSENT'], 45_000);
    if (state !== 'STOPPED' && state !== 'ABSENT') {
      updateLogError(
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
      updateLogError(
        `Port ${port} still held by PID(s) ${holders.join(', ')} after kill attempts. Aborting update.`
      );
      return false;
    }
    for (const pid of holders) {
      updateLog(`Killing stale process ${pid} holding port ${port}`);
      await runCmd(`taskkill /PID ${pid} /F /T`, 15_000);
    }
    await sleep(1000);
  }
}

const START_ATTEMPTS = 3;
const START_RETRY_MS = 5_000;

// sc.exe prints localized text but the numeric code is invariant, so the code
// is what we key off — and what a technician can look up.
const SC_ERRORS: Record<string, string> = {
  '1053': 'the service did not respond in time (it started but died)',
  '1056': 'the service is already running',
  '1060': 'the service is not installed',
  '1061': 'the service is busy (still stopping)',
  '1062': 'the service is not started',
  '5': 'access denied - not running as administrator',
};

// sc.exe exits with the Win32 error itself; the printed text is localized.
export function scErrorCode(code: number, output: string): number | null {
  if (code) return code;
  const match = output.match(/FAILED\s+(\d+)|\b(\d{1,4})\b(?=:)/);
  const parsed = Number(match?.[1] ?? match?.[2]);
  return Number.isFinite(parsed) && parsed ? parsed : null;
}

export function describeScError(code: number, output: string): string {
  const scCode = scErrorCode(code, output);
  const known = scCode ? SC_ERRORS[String(scCode)] : null;
  const trimmed = output.trim();
  return known ? `${trimmed} (${known})` : trimmed;
}

/** Can this process drive the SCM at all? Everything else follows from it. */
export async function isElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  // Not `net session`: that also fails when the Server service is disabled,
  // which would report a perfectly elevated process as unprivileged.
  const { code, output } = await runCmd(
    'powershell -NoProfile -NonInteractive -Command "(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"',
    15_000
  );
  if (code === 0) return /true/i.test(output);
  return (await runCmd('net session', 15_000)).code === 0;
}

/** Where the SCM thinks the service lives — the install we are really updating. */
export async function getServiceImagePath(): Promise<string | null> {
  const { code, output } = await runCmd(
    `powershell -NoProfile -NonInteractive -Command "(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\${SERVICE_NAME}' -ErrorAction SilentlyContinue).ImagePath"`,
    15_000
  );
  if (code !== 0) return null;
  const trimmed = output.trim();
  return trimmed || null;
}

// The one flag every build's launcher understands: skip the boot-time update
// check and go straight to listening.
const NO_UPDATE_ARG = '--noupdate';
const SERVICE_XML_FILE = 'printerServerService.xml';
// Left in the install by builds whose update check honours the failed-release
// marker, i.e. the ones that can refuse a capped release on their own.
const BOOT_GUARD_FILE = 'honors-failed-release';

/** Does this xml already start the exe with updates off? */
export function xmlSuppressesUpdates(xml: string): boolean {
  return new RegExp(
    `<arguments>[^<]*${NO_UPDATE_ARG}|<argument>\\s*${NO_UPDATE_ARG}\\s*</argument>`
  ).test(xml);
}

/**
 * The same xml with `--noupdate` added, or null when it is not a file we can
 * safely edit. WinSW reads <arguments> on every start — unlike <onfailure>,
 * which only reaches the SCM at install time.
 */
export function serviceXmlWithNoUpdate(xml: string): string | null {
  if (/<arguments>[\s\S]*?<\/arguments>/.test(xml)) {
    return xml.replace(
      /<arguments>([\s\S]*?)<\/arguments>/,
      (_match, inner) =>
        `<arguments>${[inner.trim(), NO_UPDATE_ARG].filter(Boolean).join(' ')}</arguments>`
    );
  }
  // WinSW's list form: keep it a list rather than mixing the two spellings.
  const lastArgument = xml.lastIndexOf('</argument>');
  if (lastArgument !== -1) {
    const end = lastArgument + '</argument>'.length;
    return `${xml.slice(0, end)}\n  <argument>${NO_UPDATE_ARG}</argument>${xml.slice(end)}`;
  }
  if (!xml.includes('</service>')) return null;
  return xml.replace(
    '</service>',
    `  <arguments>${NO_UPDATE_ARG}</arguments>\n</service>`
  );
}

/**
 * Turn off an install's boot-time update check through the xml its service
 * starts from. The next successful install lays the release's own xml down
 * again, so the suppression undoes itself.
 */
export function suppressBootUpdates(buildsDir: string): boolean {
  const xmlPath = path.join(buildsDir, SERVICE_XML_FILE);
  let xml = '';
  try {
    xml = fs.readFileSync(xmlPath, 'utf-8');
  } catch (err: any) {
    updateLogError(`Could not read ${xmlPath}:`, err.message || err);
    return false;
  }

  if (xmlSuppressesUpdates(xml)) {
    updateLog(`${xmlPath} already starts the server with ${NO_UPDATE_ARG}.`);
    return true;
  }

  const next = serviceXmlWithNoUpdate(xml);
  if (!next) {
    updateLogError(`${xmlPath} is not a service xml we can edit.`);
    return false;
  }

  try {
    fs.writeFileSync(xmlPath, next);
  } catch (err: any) {
    updateLogError(`Could not write ${xmlPath}:`, err.message || err);
    return false;
  }
  // Only installs without the boot guard get here, and those predate the
  // backend update command: force_autoupdate.bat on site is the one way out.
  updateLog(
    `Updates suppressed in ${xmlPath}: the service now starts with ${NO_UPDATE_ARG}. This build cannot take an update from the backend, so the install stays on its current version until a technician runs force_autoupdate.bat; the next install lays the release's own xml down again.`
  );
  return true;
}

/**
 * Say, in the install dir, that this build's update check honours the marker.
 * Builds older than it download and hand off before they listen.
 */
export function markBootUpdateGuard(): void {
  try {
    fs.writeFileSync(BOOT_GUARD_FILE, new Date().toISOString());
  } catch (err: any) {
    updateLog('Could not write the boot-update guard:', err.message || err);
  }
}

/** Can this install refuse a capped release on its own? */
export function hasBootUpdateGuard(installDir: string): boolean {
  if (!installDir) return false;
  return fs.existsSync(path.join(installDir, 'builds', BOOT_GUARD_FILE));
}

/**
 * Start the service and confirm it actually reached Running. Falls back to
 * launching the exe directly only if the SCM refuses (service missing, or no
 * privileges — force_autoupdate.bat runs as the technician, not LocalSystem),
 * so a failed `sc start` can never leave the venue with nothing running.
 * `suppressUpdates` is for the caller that hands the machine back to an install
 * which would otherwise update itself out of existence again.
 */
export async function startServiceOrFallback(
  installDir: string,
  options: { suppressUpdates?: boolean } = {}
): Promise<boolean> {
  // The launch must run from the *installed* builds dir, not the updater's
  // temp cwd, or the fallback instance reads config.json/settings.json/version
  // out of %TMP%.
  const buildsDir = path.join(path.resolve(installDir), 'builds');
  const exe = path.join(buildsDir, 'printerServer.exe');
  // The SCM passes the arguments from the xml, so suppressing updates has to
  // reach the xml first; if it cannot, a serving unmanaged process beats a
  // service that downloads and exits before listening.
  const startArgs = options.suppressUpdates ? [NO_UPDATE_ARG] : [];
  const canStartService = options.suppressUpdates
    ? suppressBootUpdates(buildsDir)
    : true;

  if (!canStartService) {
    updateLogError(
      'Could not suppress updates in the service xml. Skipping sc start: starting the service would put this install back into the update loop.'
    );
  }

  // One `sc start` was not enough: right after a stop the SCM can still be
  // finishing (1053/1061), and a single refusal used to drop straight to an
  // unmanaged process. Retry while the service is merely stopped.
  for (
    let attempt = 1;
    canStartService && attempt <= START_ATTEMPTS;
    attempt += 1
  ) {
    const { code, output } = await runCmd(
      `sc.exe start ${SERVICE_NAME}`,
      30_000
    );
    // 1056 = already running.
    if (code === 0 || /1056/.test(output)) break;

    updateLogError(
      `sc start attempt ${attempt}/${START_ATTEMPTS} returned ${code}: ${describeScError(code, output)}`
    );
    // Denied is not a race — retrying the same call as the same user cannot
    // help, and the caller needs the fallback now.
    if (scErrorCode(code, output) === 5) break;
    if (attempt < START_ATTEMPTS) await sleep(START_RETRY_MS);
  }

  if (canStartService) {
    const state = await waitForState(['RUNNING'], 45_000);
    if (state === 'RUNNING') {
      updateLog('Service is running.');
      return true;
    }
    updateLogError(
      `Service did not reach Running (state: ${state}). Falling back to a direct launch.`
    );
  }

  updateLogError(
    `RUNNING UNMANAGED: ${SERVICE_NAME} is NOT running. The printer server was started as a plain process — it dies at logoff and nothing restarts it. Run install_printer_service.bat as administrator to repair.`
  );
  if (!launchDetached(exe, startArgs, buildsDir)) return false;

  // `cmd /c start` exits 0 even when it launched nothing (AV, Smart App
  // Control). Reporting that as a start would mark the release good with the
  // service stopped and nothing on the port, so wait for the exe's own lock.
  if (await waitForExeLock(exe)) return true;
  updateLogError(
    `Fallback launch of ${exe} never took: no process is running it.`
  );
  return false;
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
 * quoting of the nested PowerShell check does not survive Node's argument
 * escaping.
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
        // `sc query | find "RUNNING"` never matches on a localized Windows,
        // which would launch a second server on every restart.
        `powershell -NoProfile -NonInteractive -Command "if ((Get-Service -Name '${SERVICE_NAME}' -ErrorAction SilentlyContinue).Status -eq 'Running') { exit 0 } else { exit 1 }"`,
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
    updateLogError(
      'Failed to schedule the service-start watchdog:',
      err.message || err
    );
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
  return (await probeServiceManaged()) === true;
}

/**
 * The same probe, but `null` when it could not be answered (WMI hung, timed
 * out). Callers for which "not managed" is the dangerous answer — standing down
 * as the redundant instance — need that difference.
 */
export async function probeServiceManaged(): Promise<boolean | null> {
  if (process.platform !== 'win32') return false;
  const ppid = process.ppid;
  if (!ppid) return false;
  const { code, output } = await runCmd(
    `powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${ppid}').Name"`,
    15_000
  );
  if (code !== 0) return null;
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
      updateLog(`Deleted: ${folderPath}`);
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      if (!silent) {
        updateLog(`Folder does not exist: ${folderPath}`);
      }
    } else {
      if (!silent) {
        updateLogError(`Error deleting ${folderPath}:`, err.message || err);
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

// A rollback restarts the old install, which finds the same newer tag and
// updates again — a loop that never reaches app.listen(). The marker counts the
// failed attempts per release so a transient one (AV lock, a slow stop) still
// gets retried, while a release that is genuinely broken here stops the loop.
// It lives in the install's builds dir, next to `version`.
const FAILED_RELEASE_FILE = 'failed-release.json';
export const MAX_RELEASE_ATTEMPTS = 3;

interface FailedRelease {
  attempts: number;
  version: string;
}

const failedReleasePath = (buildsDir?: string) =>
  buildsDir ? path.join(buildsDir, FAILED_RELEASE_FILE) : FAILED_RELEASE_FILE;

export function readFailedRelease(buildsDir?: string): FailedRelease | null {
  try {
    const raw = fs.readFileSync(failedReleasePath(buildsDir), 'utf-8');
    const { attempts, version } = JSON.parse(raw) || {};
    if (typeof version !== 'string' || !version) return null;
    return { attempts: Number(attempts) || 0, version };
  } catch {
    return null;
  }
}

export function clearFailedRelease(buildsDir?: string): void {
  try {
    fs.rmSync(failedReleasePath(buildsDir), { force: true });
  } catch (err: any) {
    updateLogError('Could not clear the failed-release marker:', err.message);
  }
}

/**
 * Count this failed install against the release being installed. The version is
 * the updater's own — it runs from the new build — and the marker goes to the
 * install we are about to restart.
 */
export function noteFailedRelease(installDir: string): void {
  if (!installDir) return;
  const buildsDir = path.join(installDir, 'builds');
  let version = '';
  try {
    version = fs.readFileSync('version', 'utf-8').trim();
  } catch {
    updateLog('No version file in the new build; nothing to mark as failed.');
    return;
  }

  const previous = readFailedRelease(buildsDir);
  const attempts = (previous?.version === version ? previous.attempts : 0) + 1;
  try {
    fs.writeFileSync(
      failedReleasePath(buildsDir),
      JSON.stringify({ at: new Date().toISOString(), attempts, version })
    );
    updateLog(
      `Release ${version} has now failed ${attempts}/${MAX_RELEASE_ATTEMPTS} time(s) on this machine.`
    );
  } catch (err: any) {
    updateLogError('Could not write the failed-release marker:', err.message);
  }
}

/**
 * Reason to refuse installing the build we are running from into `installDir`,
 * or null to go ahead. Read from the marker in the install, written by whichever
 * updater failed last. `force` is the technician's way out.
 */
export function overCapRelease(
  installDir: string,
  force: boolean
): string | null {
  if (!installDir || force) return null;
  let version = '';
  try {
    version = fs.readFileSync('version', 'utf-8').trim();
  } catch {
    return null; // No version in the new build; nothing to match a marker on.
  }

  const failed = readFailedRelease(path.join(installDir, 'builds'));
  if (failed?.version !== version || failed.attempts < MAX_RELEASE_ATTEMPTS) {
    return null;
  }
  return `${version} already failed to install here ${failed.attempts} time(s). The install was left untouched. Fix the machine (disk, antivirus, locked files) and run force_autoupdate.bat, or ask for an update from the backend.`;
}

async function fetchLatestReleaseVersion(): Promise<string | null> {
  const versionUrl = nconf.get('CODE_VERSION_URL');
  if (!versionUrl) {
    updateLog('CODE_VERSION_URL not configured. Skipping version check.');
    return null;
  }

  try {
    updateLog('Fetching latest release info from:', versionUrl);

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
    reportIfViaFallback(result);
    const releaseData = result.data;
    const tagName = releaseData.tag_name;

    if (!tagName) {
      updateLog('No tag_name found in release data');
      return null;
    }

    updateLog('Latest release version:', tagName);
    return tagName;
  } catch (err: any) {
    updateLogError(
      'Error fetching latest release version:',
      err.message || err
    );
    return null;
  }
}

export interface UpdateCheckResult {
  currentVersion?: string;
  error?: string;
  latestVersion?: string;
  state: 'already-latest' | 'updating' | 'failed';
}

/**
 * Work that must reach the backend before the updater child is spawned. The
 * child's first act is `sc stop printerServer` — this process — so anything
 * reported after the handoff is racing its own executioner.
 */
export type BeforeHandoff = (result: UpdateCheckResult) => Promise<unknown>;

export async function downloadLatestCode(
  relaunchDelayMs = 500,
  beforeHandoff?: BeforeHandoff,
  // An explicit update request (technician, or a remote command) is the way out
  // of a release that keeps failing: it retries and resets the counter.
  force = false
): Promise<UpdateCheckResult> {
  // This build refuses a capped release below, so an updater handing the
  // machine back to it never has to suppress its updates.
  markBootUpdateGuard();

  // Read current version
  let currentVersion = '';
  try {
    currentVersion = (await fsp.readFile('version', 'utf-8')).trim();
    updateLog('Current version:', currentVersion);
  } catch {
    updateLog('No current version file found, assuming update needed.');
  }

  // Fetch latest version from GitHub API (without downloading)
  const latestVersion = await fetchLatestReleaseVersion();

  if (latestVersion) {
    // Compare versions before downloading
    if (isLatestVersion(currentVersion, latestVersion)) {
      updateLog('Already up to date. No download needed.');
      updateLog(`Current: ${currentVersion}, Latest: ${latestVersion}`);
      return { currentVersion, latestVersion, state: 'already-latest' };
    }
    updateLog('Update available!');
    updateLog(`Current: ${currentVersion} -> Latest: ${latestVersion}`);

    const failed = readFailedRelease();
    if (failed?.version === latestVersion && !force) {
      if (failed.attempts >= MAX_RELEASE_ATTEMPTS) {
        const error = `Release ${latestVersion} failed to install here ${failed.attempts} times; not retrying automatically. Fix the machine (disk, antivirus, locked files) and run force_autoupdate.bat, or ask for an update from the backend.`;
        updateLogError(error);
        return { currentVersion, error, latestVersion, state: 'failed' };
      }
      updateLog(
        `Release ${latestVersion} failed ${failed.attempts}/${MAX_RELEASE_ATTEMPTS} time(s) here; retrying.`
      );
    } else if (failed) {
      // A newer release, or an explicit request: the old count is meaningless.
      clearFailedRelease();
    }
  } else {
    updateLog(
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
  updateLog('Starting download from:', url);

  const srcDir = await fsp.mkdtemp(tempDirPath);
  const zipPath = path.resolve(srcDir, 'quickord-cashier-server.zip');

  const downloadResult = await tryFetchWithFallback<void>({
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
  reportIfViaFallback(downloadResult);

  // Extract zip
  const tempCodePath = path.resolve(srcDir, 'code');
  await fsp.mkdir(tempCodePath, { recursive: true });
  const zipBuffer = await fsp.readFile(zipPath);
  await extractZip(zipBuffer, tempCodePath);

  updateLog('Update needed. Code ready at:', tempCodePath);
  updateLog('Updating to latest version');
  updateLog(tempCodePath);
  const cwd = process.cwd();
  const parentDir = path.resolve(cwd, '..');

  args[1] = tempCodePath;
  args[2] = '--parent';
  args[3] = parentDir;
  // The updater repeats the failed-release check, so it needs to know this run
  // is the explicit one that is allowed past it.
  if (force) args[4] = '--force';
  else args.length = 4;
  path2 = tempCodePath + '/builds/printerServer.exe';

  const result: UpdateCheckResult = {
    currentVersion,
    latestVersion,
    state: 'updating',
  };

  // The spawn below is the point of no return: the child stops the service —
  // us — before it copies anything, and no exit delay or pre-exit task on this
  // side can outrun it. So the result is reported here, while nothing is yet
  // trying to kill us. Capped, because a backend that never answers must not
  // block the update itself.
  if (beforeHandoff) {
    await Promise.race([
      beforeHandoff(result).catch(() => {}),
      sleep(PRE_EXIT_CAP_MS),
    ]);
  }

  if (await relaunchExe(path2, args, relaunchDelayMs)) return result;

  // The updater never started, so nothing is stopping the service and we are
  // still here. Returning 'failed' is what corrects the 'updating' just reported
  // — the caller sends the correction — and what releases the in-flight latch so
  // the next command can retry. beforeHandoff is deliberately not called again:
  // it is a one-shot report for a handoff that did not happen.
  const error = `Could not start the updater at ${path2}; staying on ${currentVersion}.`;
  updateLogError(error);
  return { currentVersion, error, latestVersion, state: 'failed' };
}

// Update trigger registered by index.ts, mirroring setRestartHandler. Lets the
// WS/pull control channels ask for an explicit version check without going
// through a restart — when there is nothing new, the server keeps running.
type UpdateHandler = (
  beforeHandoff?: BeforeHandoff
) => Promise<UpdateCheckResult>;

let updateHandler: UpdateHandler | null = null;

export function setUpdateHandler(fn: UpdateHandler): void {
  updateHandler = fn;
}

// The pull channel can deliver the same update command twice (the backend may
// retry, or a user may click twice). Without a guard each one spawns its own
// updater against the same install directory — two processes deleting and
// copying the same tree. The in-flight run is shared instead, so the second
// caller gets the first one's answer — including its pre-handoff report, so a
// duplicate command's own report stays fire-and-forget.
let updateInFlight: Promise<UpdateCheckResult> | null = null;

export async function triggerUpdate(
  beforeHandoff?: BeforeHandoff
): Promise<UpdateCheckResult> {
  if (!updateHandler) {
    return { error: 'No update handler registered', state: 'failed' };
  }
  if (updateInFlight) {
    updateLog('An update is already in flight; reusing its result.');
    return updateInFlight;
  }
  updateInFlight = (async () => {
    try {
      return await updateHandler!(beforeHandoff);
    } catch (err: any) {
      return { error: err?.message || String(err), state: 'failed' as const };
    }
  })();
  try {
    const result = await updateInFlight;
    // Only a started update is worth latching: on `already-latest`/`failed`
    // this process keeps running and must stay able to retry later.
    if (result.state !== 'updating') updateInFlight = null;
    return result;
  } catch {
    updateInFlight = null;
    return { error: 'Update failed', state: 'failed' };
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
  const self = path.resolve(process.execPath).toLowerCase();

  for (const name of entries) {
    if (!name.startsWith('quickord-cashier-server-update')) continue;
    const full = path.join(base, name);
    const lower = full.toLowerCase();
    const prefix = lower + path.sep;
    // Never delete the tree we are running from — by cwd or by exe, since the
    // updater chdir's into it but a fallback launch may not.
    if (cwd === lower || cwd.startsWith(prefix)) continue;
    if (self.startsWith(prefix)) continue;
    // We are the *new* server, started by an updater that is still waiting for
    // us to reach Running from its own temp tree. Its exe is locked while it
    // lives, so leave that tree to the next boot.
    if (isUpdaterStillRunningIn(full)) {
      updateLog(`Leaving ${full} alone: its updater is still running.`);
      continue;
    }
    await safeCleanup(full);
  }
}

// The exe lock is the only signal the new server has that an updater is still
// live in that tree.
function isUpdaterStillRunningIn(dir: string): boolean {
  return isExeLocked(path.join(dir, 'code', 'builds', 'printerServer.exe'));
}

export async function safeCleanup(dirPath: string) {
  try {
    const resolvedPath = path.resolve(dirPath);
    const stat = await fsp.stat(resolvedPath).catch(() => null);
    if (!stat) return; // folder doesn't exist

    // Tiny delay to ensure all streams are closed
    await new Promise((res) => setTimeout(res, 50));

    await rmrf(resolvedPath);
    updateLog('✅ Temp folder cleaned up:', resolvedPath);
  } catch (err: any) {
    updateLogError('⚠️ Failed to clean temp folder:', err.message);
  }
}

/**
 * Delete that *reports* failure. `safeCleanup`/`deleteFolderRecursive` swallow
 * errors, which is fine for temp dirs but not on the update path: there, a
 * silently failed delete is how a half-written install gets started.
 */
async function removePath(target: string): Promise<void> {
  await rmrf(path.resolve(target));
}

// Empty a directory without removing the directory itself — the only way to
// clear an install whose *parent* denies writes (where rename/rmdir fail but
// the contents are still deletable).
async function clearDirContents(dir: string): Promise<void> {
  const entries = await fsp.readdir(dir).catch((err: any) => {
    if (err?.code === 'ENOENT') return [] as string[];
    throw err;
  });
  for (const name of entries) {
    await rmrf(path.join(dir, name));
  }
}

// A build is only usable if the exe is actually there; xcopy can return 0 after
// skipping files, and a truncated copy must not be treated as a live install.
function hasServerExe(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'builds', 'printerServer.exe'));
}

// Losing printerServerService.exe leaves the running server up but the service
// unstartable (and un-uninstallable) at the next reboot. node_modules carries
// the native deps (serialport, sharp), so new exes on a missing or empty one
// are a dead install — the same rule updater.js validates before it stages.
// Checked on the new build only — an install already missing them is what an
// update must repair.
function missingBuildFiles(dir: string): string[] {
  const builds = path.join(dir, 'builds');
  const missing = ['printerServer.exe', 'printerServerService.exe'].filter(
    (name) => !fs.existsSync(path.join(builds, name))
  );
  const modules = path.join(dir, 'node_modules');
  const populated = (() => {
    try {
      return fs.readdirSync(modules).length > 0;
    } catch {
      return false;
    }
  })();
  if (!populated) missing.push('node_modules');
  return missing;
}

type InstallBackup = {
  /** Where the previous install now lives. */
  path: string;
  /** true = the install dir was renamed away, false = copied then emptied. */
  moved: boolean;
};

/**
 * Put the current install somewhere recoverable before it is overwritten.
 *
 * Preferred path is a rename (atomic, cheap). When that fails — typically a
 * parent directory that denies writes — we fall back to *copying* the install
 * into %TMP% and then emptying it, never to deleting it outright: an update
 * that proceeds with no backup is exactly the failure mode that bricks a venue.
 * Returns null when neither worked, and in that case the install is left
 * completely untouched so the caller can just start it again.
 */
async function backupInstall(
  installDir: string
): Promise<InstallBackup | null> {
  const sibling = `${installDir}.old`;
  try {
    await removePath(sibling); // a leftover from an earlier failed attempt
    await fsp.rename(installDir, sibling);
    updateLog(`Previous install moved aside to ${sibling}`);
    return { moved: true, path: sibling };
  } catch (err: any) {
    updateLogError(
      `Could not move the old install aside (${err.message || err}); falling back to a copied backup.`
    );
  }

  // Not under tmpdir()/quickord-cashier-server-update*, so sweepTempUpdateDirs
  // cannot delete a backup we may still need.
  const tmpBackup = path.join(tmpdir(), 'quickord-install-backup');
  try {
    await removePath(tmpBackup);
    await copyWithCmd(installDir, tmpBackup);
    if (!hasServerExe(tmpBackup)) {
      throw new Error(
        `backup at ${tmpBackup} is missing builds\\printerServer.exe`
      );
    }
  } catch (err: any) {
    updateLogError(
      `Could not back up the current install (${err.message || err}).`
    );
    // Nothing has touched `installDir` yet, so it is still exactly as it was.
    // The copy may have left a partial backup behind; it is worthless.
    await safeCleanup(tmpBackup);
    return null;
  }

  // From here on the backup is verified, so it must survive: emptying the
  // install can fail halfway and leave a partial install behind, and the only
  // way back from that is this backup. Returning null here would tell the
  // caller the install is untouched and let it start a gutted directory.
  try {
    await clearDirContents(installDir);
  } catch (err: any) {
    updateLogError(
      `Could not fully empty ${installDir} (${err.message || err}); continuing — the new build is copied over it and ${tmpBackup} can restore it.`
    );
  }
  updateLog(`Previous install backed up to ${tmpBackup}`);
  return { moved: false, path: tmpBackup };
}

/** Put the backup taken by `backupInstall` back where it came from. */
async function restoreInstall(
  backup: InstallBackup,
  installDir: string
): Promise<boolean> {
  try {
    if (backup.moved) {
      await removePath(installDir);
      await fsp.rename(backup.path, installDir);
    } else {
      await clearDirContents(installDir);
      await copyWithCmd(backup.path, installDir);
    }
    if (!hasServerExe(installDir)) {
      throw new Error(`restored install at ${installDir} has no exe`);
    }
    return true;
  } catch (err: any) {
    updateLogError(
      'Failed to restore the previous install:',
      err.message || err
    );
    return false;
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
        updateLogError(`Error: ${stderr}`);
        return reject(error);
      }
      updateLog(stdout);
      resolve(undefined);
    });
  });
}

function runServiceConfigCmd(cmd: string): Promise<void> {
  return new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        updateLogError(
          `Failed to apply service config (${cmd}):`,
          stderr || error.message
        );
      } else {
        updateLog('Service config applied:', stdout.trim());
      }
      resolve();
    });
  });
}

/**
 * Service settings that live in the SCM's registry entry, not in the xml.
 * `printerServerService.exe install` writes them once; an update only copies
 * files, so re-applying them here is the only way they reach existing
 * installs. Both calls are idempotent.
 */
function applyServiceConfig(): Promise<void> {
  const cmds = [
    'sc.exe config printerServer start= delayed-auto depend= Tcpip/Dnscache/NlaSvc',
    // Mirrors <onfailure action="restart" delay="5 sec"/>. Without this the SCM
    // reads a non-zero exit as "service finished" and leaves the venue down.
    'sc.exe failure printerServer reset= 86400 actions= restart/5000/restart/5000/restart/60000',
  ];
  return cmds.reduce(
    (chain, cmd) => chain.then(() => runServiceConfigCmd(cmd)),
    Promise.resolve()
  );
}

function copySettingsFile(settingsPath, destDir) {
  return new Promise((resolve, reject) => {
    const command = `xcopy "${settingsPath}" "${path.join(destDir, 'builds')}\\" /Y`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        updateLogError(`Error copying settings: ${stderr}`);
        return reject(error);
      }
      updateLog('Settings file copied with xcopy.');
      resolve(undefined);
    });
  });
}

/**
 * Carry the venue's log history into the new install. The whole install dir is
 * renamed away and rebuilt from the release, so without this every update wipes
 * app.log — which is exactly the history you need when an update goes wrong.
 */
async function preserveLogs(installDir: string, stagingDir: string) {
  const from = path.join(installDir, 'builds');
  const to = path.join(stagingDir, 'builds');
  let names: string[] = [];
  try {
    names = await fsp.readdir(from);
  } catch {
    return;
  }

  const logs = names.filter((n) => /^(app|autoupdate)(\.\d+)?\.log$/.test(n));
  for (const name of logs) {
    try {
      await fsp.copyFile(path.join(from, name), path.join(to, name));
    } catch (err: any) {
      updateLogError(`Could not preserve ${name}:`, err.message || err);
    }
  }
  if (logs.length) updateLog(`Preserved ${logs.length} log file(s).`);
}
export default async function autoUpdate(path: string[]) {
  updateLog('AutoUpdate path:', path);
  // Check if running on Windows
  if (process.platform !== 'win32') {
    updateLog('Skipping auto-update: non-Windows OS detected.');
    return;
  }

  if (path.length === 0) {
    await downloadLatestCode();
    return;
  }

  if (path[0] === '--update') {
    markUpdaterProcess();
    let ok = false;
    try {
      ok = await runUpdater(path);
    } finally {
      // Every exit path, including a throw: the runs worth reading are the ones
      // that failed. destDir is set by runUpdater before anything can throw.
      if (!ok) noteFailedRelease(destDir);
      flushUpdateLog(destDir);
    }
    // This process is the updater, not a server: it runs from %TMP% and the
    // real instance is already back up under the service manager. Falling
    // through to main() would bind the port from the temp copy. The exit code
    // is what a technician running force_autoupdate.bat sees.
    process.exit(ok ? 0 : 1);
  }
}

/** One line that says which process this is and what it is about to touch. */
async function logUpdaterPreamble(): Promise<void> {
  const elevated = await isElevated();
  updateLog(
    `Updater starting — pid ${process.pid}, elevated: ${elevated}, cwd: ${process.cwd()}`
  );
  updateLog(`argv: ${JSON.stringify(process.argv)}`);
  updateLog(`srcDir: ${srcDir}`);
  updateLog(`destDir: ${destDir}`);
  updateLog(`Service state: ${await getServiceState()}`);

  const imagePath = await getServiceImagePath();
  updateLog(`Service binary: ${imagePath ?? 'unknown'}`);
  // We update the folder we were launched from, but start the service the SCM
  // knows about. When those are two different installs, the update lands
  // somewhere the service will never run from.
  const installed = imagePath
    ? path.resolve(path.dirname(imagePath.replace(/^"|"$/g, '')), '..')
    : null;
  if (
    installed &&
    destDir &&
    path.resolve(destDir).toLowerCase() !== installed.toLowerCase()
  ) {
    updateLogError(
      `Install mismatch: updating ${path.resolve(destDir)} but the service runs from ${installed}.`
    );
  }

  if (!elevated) {
    updateLogError(
      'Not running elevated: sc config/failure/start will be denied, and the update will end with an unmanaged process instead of a service.'
    );
  }
}

/**
 * The `--update` mode: replace the install directory and hand control back to
 * the service manager. Runs from the freshly downloaded copy in %TMP%, so it is
 * free to overwrite the install underneath it.
 */
async function runUpdater(path: string[]): Promise<boolean> {
  srcDir = path[1]?.toString() || '';
  destDir = path[3]?.toString() || '';
  process.chdir(srcDir + '\\builds');

  await logUpdaterPreamble();

  // Second home of the failed-release check. The boot-time one lives in the
  // server, so a rollback to an install that predates it re-downloads the same
  // release on every boot; this one runs from the *new* build, so it is always
  // present, and aborting here costs a download instead of a stop-copy-rollback
  // cycle with the venue offline for it.
  const cappedRelease = overCapRelease(destDir, path.includes('--force'));
  if (cappedRelease) {
    updateLogError(`Update aborted: ${cappedRelease}`);
    // An install older than the boot-time check re-downloads this release the
    // moment it starts and exits before listening, so it goes back up with its
    // update check off. One that can refuse the release itself starts normally
    // and still takes a later release on its own.
    await startServiceOrFallback(destDir, {
      suppressUpdates: !hasBootUpdateGuard(destDir),
    });
    return false;
  }

  const port = Number(nconf.get('PORT')) || 7810;

  // Validate the download before anything destructive: backupInstall() renames
  // the whole install away, so a release found broken only after the copy costs
  // a rollback. Aborting here leaves the install exactly as it was.
  const staged = missingBuildFiles(srcDir);
  if (staged.length) {
    updateLogError(
      `Update aborted: the downloaded release at ${srcDir} is missing ${staged.join(', ')}.`
    );
    await startServiceOrFallback(destDir);
    return false;
  }

  // Stop the service (and any orphan holding the port) BEFORE touching the
  // install dir. If that fails, the old install is still intact and running —
  // far better than a half-copied directory with the service down.
  if (!(await stopServiceAndFreePort(port))) {
    updateLogError('Update aborted: could not free the install directory.');
    await startServiceOrFallback(destDir);
    return false;
  }

  // settings.json is the only per-venue state in the install dir. Losing it
  // means a venue with no printers configured, so a failed backup aborts the
  // update instead of deleting anything.
  const settingsPath = `${destDir}\\builds\\settings.json`;
  if (fs.existsSync(settingsPath)) {
    try {
      await copySettingsFile(settingsPath, srcDir);
    } catch (err: any) {
      updateLogError(
        'Update aborted: failed to back up settings.json:',
        err.message || err
      );
      await startServiceOrFallback(destDir);
      return false;
    }
  } else {
    updateLog(`No settings.json at ${settingsPath}, nothing to preserve.`);
  }

  // Logs are not worth aborting for, but they are worth keeping.
  await preserveLogs(destDir, srcDir);

  // The old install is preserved, never deleted outright, so a copy that dies
  // halfway (disk full, ACL, AV quarantine, a file that got re-locked) does not
  // leave the venue with an empty or half-written install directory. No
  // backup means no update: the install stays exactly as it was.
  const backup = await backupInstall(destDir);
  if (!backup) {
    updateLogError(
      'Update aborted: could not back up the current install. It was left untouched.'
    );
    await startServiceOrFallback(destDir);
    return false;
  }

  try {
    await fsp.mkdir(destDir, { recursive: true });
    updateLog('paths: ', srcDir, destDir);
    await copyWithCmd(srcDir, destDir);
    const missing = missingBuildFiles(destDir);
    if (missing.length) {
      throw new Error(
        `copy finished but ${destDir}\\builds is missing ${missing.join(', ')}`
      );
    }
  } catch (err: any) {
    updateLogError('Copy of the new build failed:', err.message || err);
    updateLogError('Restoring the previous install from the backup.');
    if (!(await restoreInstall(backup, destDir))) {
      // Starting here would run a knowingly incomplete install. Leave the
      // backup in place and say exactly where it is instead — a service that
      // is down is recoverable by hand, a corrupted one silently misprints.
      updateLogError(
        `CRITICAL: ${destDir} is incomplete and the rollback failed. The previous install is at ${backup.path}; restore it manually. Not starting the service.`
      );
      return false;
    }
    updateLog('Previous install restored. Update aborted.');
    await applyServiceConfig();
    await startServiceOrFallback(destDir);
    return false;
  }

  // Only now, with a verified new build on disk, is the backup expendable.
  await safeCleanup(backup.path);
  await applyServiceConfig();
  return startServiceOrFallback(destDir);
  // The temp folder is left behind on purpose: this process lives in it. The
  // newly started server sweeps it on boot (sweepTempUpdateDirs).
}
