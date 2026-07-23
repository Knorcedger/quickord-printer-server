// updater.js
//
// Standalone updater run by force_autoupdate.bat (compiled to updater.exe).
// Separate process because a running server can't overwrite its own exe.
//
// Safety rule: nothing in the live install is touched until a full release is
// downloaded, extracted AND validated in staging. A bad download aborts with
// the install intact. It can't replace its own running exe, so a new
// updater.exe is staged as updater.exe.new for the .bat to swap in.
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip/adm-zip.js");

// Compiled: root = folder next to the exe. Under `node`: __dirname.
const execName = path.basename(process.execPath).toLowerCase();
const IS_COMPILED = execName !== "node" && execName !== "node.exe";
const ROOT_DIR = IS_COMPILED ? path.dirname(process.execPath) : __dirname;
const SELF_EXE = IS_COMPILED ? path.basename(process.execPath).toLowerCase() : null;

const BUILD_DIR = path.join(ROOT_DIR, "builds");
const SETTINGS_FILE = path.join(BUILD_DIR, "settings.json");
const CONFIG_FILE = path.join(BUILD_DIR, "config.json");

// Staging on the same volume as the install (cheap rename swap); cleaned in finally.
const STAGING_DIR = path.join(ROOT_DIR, ".update-staging");
const ZIP_PATH = path.join(STAGING_DIR, "latest.zip");
const EXTRACT_DIR = path.join(STAGING_DIR, "extracted");
const SETTINGS_BACKUP = path.join(STAGING_DIR, "settings_backup.json");

const PORT = 7810;

// Exit code the .bat wrapper watches for: the install was left in a mixed or
// partial state (a rollback itself failed) and MUST NOT be started. A service
// that is down is recoverable by hand; a half-swapped one silently misprints.
const CRITICAL_EXIT = 3;

// Thrown when the install is knowingly inconsistent. main() propagates it as
// CRITICAL_EXIT and never restarts the service; the .bat wrapper skips its own
// service start on that code.
class CriticalUpdateError extends Error {
  constructor(message) {
    super(message);
    this.name = "CriticalUpdateError";
    this.critical = true;
  }
}

// Run a rollback that, if it fails, leaves the install inconsistent. Escalate a
// rollback failure to a critical error so the caller refuses to start it.
function rollbackOrCritical(rollback, what) {
  try {
    rollback();
  } catch (rollbackErr) {
    throw new CriticalUpdateError(
      `${what} rollback failed (${rollbackErr.message}); the install is left in ` +
        `a mixed/partial state and will NOT be started. Manual restore required.`
    );
  }
}

function killPort(port) {
  try {
    console.log(`Killing process on port ${port}...`);
    execSync(
      `for /f "tokens=5" %a in ('netstat -ano ^| findstr /R /C:":${port} " ^| find "LISTENING"') do taskkill /PID %a /F`,
      { stdio: "ignore" }
    );
  } catch {
    console.warn(`No process found on port ${port}`);
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

// Same URL autoupdate.ts uses; lets the manual route follow a pinned/prerelease
// build. Falls back to GitHub latest.
function getZipUrl(config) {
  if (config && config.CODE_UPDATE_URL) {
    console.log("Using CODE_UPDATE_URL from config.json");
    return config.CODE_UPDATE_URL;
  }
  console.log("No CODE_UPDATE_URL in config.json; falling back to GitHub latest.");
  const json = execSync(
    "curl -s https://api.github.com/repos/Knorcedger/quickord-printer-server/releases/latest",
    { encoding: "utf-8" }
  );
  const assets = JSON.parse(json).assets || [];
  // By name, not assets[0]: a release may also carry requirements.zip.
  const asset =
    assets.find((a) => /quickord-cashier-server\.zip$/i.test(a.name)) || assets[0];
  const url = asset && asset.browser_download_url;
  if (!url) throw new Error("No release zip found in the latest GitHub release");
  return url;
}

function downloadLatestZip(url) {
  console.log("⬇️ Downloading:", url);
  try {
    execSync(`curl -L -o "${ZIP_PATH}" "${url}"`, { stdio: "inherit" });
  } catch {
    throw new Error("Download failed");
  }
  const size = fs.existsSync(ZIP_PATH) ? fs.statSync(ZIP_PATH).size : 0;
  if (size < 1024) throw new Error(`Downloaded zip looks truncated (${size} bytes)`);
}

// Into staging, not the install root — no chance of clobbering our own updater.exe.
function extractZip() {
  console.log("📦 Extracting zip to staging...");
  new AdmZip(ZIP_PATH).extractAllTo(EXTRACT_DIR, true);
  console.log("✅ Extraction done");
}

// A partial build must never overwrite a working install.
function validateStaged() {
  const stagedBuilds = path.join(EXTRACT_DIR, "builds");
  for (const f of ["printerServer.exe", "config.json"]) {
    if (!fs.existsSync(path.join(stagedBuilds, f))) {
      throw new Error(`Staged release is missing builds/${f}`);
    }
  }
  // deploy.sh packages node_modules (native serialport etc.) into every
  // release. A release missing it is corrupt, not a "keep existing deps" case:
  // installing new builds against old native deps is exactly the mixed install
  // swapInstall() guards against. Reject it here, before touching the install.
  const stagedModules = path.join(EXTRACT_DIR, "node_modules");
  if (!fs.existsSync(stagedModules) || fs.readdirSync(stagedModules).length === 0) {
    throw new Error("Staged release is missing a non-empty node_modules folder");
  }
}

// settings.json is per-venue runtime state, not in the zip — back it up before
// replacing builds.
function backupSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    fs.copyFileSync(SETTINGS_FILE, SETTINGS_BACKUP);
    console.log("✅ settings.json backed up");
  } else {
    console.log("⚠️ settings.json not found to backup");
  }
}

// Idempotent: happy path + finally net.
function restoreSettings() {
  if (fs.existsSync(SETTINGS_BACKUP) && !fs.existsSync(SETTINGS_FILE)) {
    fs.copyFileSync(SETTINGS_BACKUP, SETTINGS_FILE);
    console.log("✅ settings.json restored");
  }
}

// Stage a replacement of a top-level folder from staging, keeping the old one
// aside. Returns { commit, rollback } so multiple folders can be swapped as one
// transaction: builds and node_modules must move together or not at all, or the
// service restarts against a mixed (new builds / old native deps) install.
function stageReplaceDir(name, { required }) {
  const staged = path.join(EXTRACT_DIR, name);
  if (!fs.existsSync(staged)) {
    if (required) throw new Error(`Staged release has no ${name} folder`);
    console.log(`Staged release has no ${name}; keeping the existing one.`);
    return { commit() {}, rollback() {} };
  }

  const live = path.join(ROOT_DIR, name);
  const backup = `${live}.old`;
  fs.rmSync(backup, { recursive: true, force: true });

  const hadLive = fs.existsSync(live);
  if (hadLive) fs.renameSync(live, backup);

  try {
    fs.cpSync(staged, live, { recursive: true, force: true });
  } catch (err) {
    console.error(`Copy of ${name} failed (${err.message}); rolling back.`);
    // If the rollback (restore of the old folder) also fails, `name` is left
    // partial — escalate so nothing tries to start it.
    try {
      fs.rmSync(live, { recursive: true, force: true });
      if (hadLive) fs.renameSync(backup, live);
    } catch (rollbackErr) {
      throw new CriticalUpdateError(
        `Copy of ${name} failed and its rollback also failed ` +
          `(${rollbackErr.message}); ${name} is left in a partial state and ` +
          `will NOT be started. Manual restore required.`
      );
    }
    throw err;
  }

  return {
    // Drop the backup only once the whole swap is known good.
    commit() {
      fs.rmSync(backup, { recursive: true, force: true });
    },
    // Restore the old folder; safe to call any time before commit().
    rollback() {
      fs.rmSync(live, { recursive: true, force: true });
      if (hadLive) fs.renameSync(backup, live);
    },
  };
}

function swapInstall() {
  backupSettings();

  const buildsTxn = stageReplaceDir("builds", { required: true });
  if (!fs.existsSync(path.join(BUILD_DIR, "printerServer.exe"))) {
    rollbackOrCritical(buildsTxn.rollback, "builds");
    throw new Error("builds was replaced but printerServer.exe is missing");
  }

  // node_modules ships with every release (validateStaged enforces it). If it
  // can't be swapped in, roll builds back too so the catch in main() restarts a
  // coherent old install, never new builds on old deps.
  let modulesTxn;
  try {
    modulesTxn = stageReplaceDir("node_modules", { required: true });
  } catch (err) {
    // node_modules already left itself partial (its own rollback failed) —
    // don't mutate further, just propagate the critical state.
    if (err.critical) throw err;
    // node_modules is intact/old; builds is new. Restore builds so main()
    // restarts a coherent old install. A failed builds rollback is critical.
    rollbackOrCritical(buildsTxn.rollback, "builds");
    throw err;
  }

  // Both folders are in place — commit (drop the backups) only now.
  buildsTxn.commit();
  modulesTxn.commit();
  restoreSettings();
}

// Can't overwrite our own running exe; stage it for the .bat to swap in.
function stageNewUpdater() {
  if (!SELF_EXE) return;
  const stagedUpdater = path.join(EXTRACT_DIR, SELF_EXE);
  if (!fs.existsSync(stagedUpdater)) return;
  try {
    fs.copyFileSync(stagedUpdater, path.join(ROOT_DIR, `${SELF_EXE}.new`));
    console.log(`Staged a new ${SELF_EXE} as ${SELF_EXE}.new.`);
  } catch (err) {
    console.warn(`Could not stage a new updater exe: ${err.message}`);
  }
}

function restartService() {
  console.log("🚀 Restarting main service...");
  // Via the SCM so the server comes back as WinSW's child. These live in the
  // registry, not the xml, so a file-only update never reaches them; idempotent.
  for (const cmd of [
    "sc.exe config printerServer start= delayed-auto depend= Tcpip/Dnscache/NlaSvc",
    "sc.exe failure printerServer reset= 86400 actions= restart/5000/restart/5000/restart/60000",
  ]) {
    try {
      execSync(cmd, { stdio: "ignore" });
    } catch (err) {
      console.warn(`⚠️ Failed to apply service config (${cmd}):`, err.message);
    }
  }
  try {
    execSync("sc start printerServer", { stdio: "ignore" });
  } catch {
    // 1056 already running (ends up RUNNING below); 1060 not installed (falls through).
  }
  for (let i = 0; i < 6; i++) {
    try {
      execSync('sc query printerServer | find "RUNNING"', { stdio: "ignore" });
      console.log("✅ Service started");
      return;
    } catch {
      execSync("ping -n 3 127.0.0.1 >nul", { stdio: "ignore" });
    }
  }
  console.warn("⚠️ Service did not start, launching the exe directly");
  spawn(path.join(BUILD_DIR, "printerServer.exe"), [], {
    detached: true,
    stdio: "ignore",
    cwd: BUILD_DIR,
  }).unref();
}

function main() {
  let swapped = false;
  try {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    fs.mkdirSync(EXTRACT_DIR, { recursive: true });

    const config = readConfig();
    downloadLatestZip(getZipUrl(config));
    extractZip();
    validateStaged();

    // Everything below touches the live install; above this a failure leaves it intact.
    killPort(PORT);
    swapInstall();
    swapped = true;
    stageNewUpdater();

    restartService();
    console.log("🎉 Update complete!");
  } catch (err) {
    console.error("❌ Updater failed:", err);
    if (err && err.critical) {
      // The install is knowingly mixed/partial (a rollback failed). Starting it
      // would run a broken server; leave it down and signal the .bat wrapper so
      // it does not start the service either. Manual restore required.
      console.error(
        `CRITICAL: the install is inconsistent and was NOT started (exit ${CRITICAL_EXIT}). Restore it manually.`
      );
      process.exitCode = CRITICAL_EXIT;
    } else if (!swapped) {
      // Never reached the swap, or the swap fully rolled back → install intact;
      // bring it back up.
      try {
        restartService();
      } catch (e) {
        console.error("Also failed to restart the service:", e.message || e);
      }
    }
    // swapped === true with a non-critical error: the new install is in place
    // and coherent; restartService() (or its fallback) already ran.
  } finally {
    try {
      restoreSettings();
    } catch (e) {
      console.error("Failed to restore settings.json:", e.message || e);
    }
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  }
}

main();
