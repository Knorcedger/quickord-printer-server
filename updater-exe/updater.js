// updater.js
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip/adm-zip.js");

const BUILD_DIR = path.join(__dirname, "builds");
const SETTINGS_FILE = path.join(BUILD_DIR, "settings.json");
const TEMP_SETTINGS = path.join(__dirname, "settings_backup.json");
const ZIP_PATH = path.join(__dirname, "latest.zip");
const SERVICE_NAME = "printerServer";

// Stop the Windows service
function stopService() {
  try {
    console.log(`Stopping service ${SERVICE_NAME}...`);
    execSync(`sc stop "${SERVICE_NAME}"`, { timeout: 10000 });
    // Wait for service to fully stop
    sleep(3000);
    console.log("Service stop requested");
  } catch {
    console.warn("Service not running or not installed");
  }
}

function sleep(ms) {
  execSync(`ping -n ${Math.ceil(ms / 1000) + 1} 127.0.0.1 >nul`, {
    windowsHide: true,
  });
}

// Kill process on port
function killPort(port) {
  try {
    console.log(`Killing process on port ${port}...`);
    execSync(
      `for /f "tokens=5" %a in ('netstat -ano ^| findstr /R /C:":${port} " ^| find "LISTENING"') do taskkill /PID %a /F`
    );
  } catch {
    console.warn(`No process found on port ${port}`);
  }
}

// Kill printerServer.exe by name
function killPrinterServer() {
  try {
    console.log("Killing printerServer.exe...");
    execSync("taskkill /IM printerServer.exe /F");
    console.log("printerServer.exe killed");
  } catch {
    console.warn("No printerServer.exe process found");
  }
}

// Backup settings.json
function backupSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    fs.copyFileSync(SETTINGS_FILE, TEMP_SETTINGS);
    console.log("settings.json backed up");
  } else {
    console.log("settings.json not found to backup");
  }
}

// Clean builds folder with retry
function cleanDirectories() {
  if (!fs.existsSync(BUILD_DIR)) return;

  const maxRetries = 5;
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.rmSync(BUILD_DIR, { recursive: true, force: true });
      console.log("Cleaned builds folder");
      return;
    } catch (err) {
      if (i < maxRetries - 1) {
        console.warn(
          `Retry ${i + 1}/${maxRetries} - builds folder still locked: ${err.message}`
        );
        sleep(2000);
      } else {
        throw new Error(
          `Failed to clean builds folder after ${maxRetries} attempts: ${err.message}`
        );
      }
    }
  }
}

// Get latest GitHub release zip URL via curl + JSON parsing
function getLatestZipUrl() {
  console.log("Fetching latest release URL...");
  const json = execSync(
    "curl -s https://api.github.com/repos/Knorcedger/quickord-printer-server/releases/latest",
    { encoding: "utf-8" }
  );
  const data = JSON.parse(json);
  const url = data.assets?.[0]?.browser_download_url;
  if (!url) throw new Error("No release zip found");
  return url;
}

// Download zip via curl
function downloadLatestZip(url) {
  console.log("Downloading:", url);
  try {
    execSync(`curl -L -o "${ZIP_PATH}" "${url}"`, { stdio: "inherit" });
  } catch (err) {
    throw new Error("Download failed");
  }
}

// Extract zip
function extractZip() {
  console.log("Extracting zip...");
  const zip = new AdmZip(ZIP_PATH);
  zip.extractAllTo(__dirname, true);
  fs.unlinkSync(ZIP_PATH);
  console.log("Extraction done");
}

// Restore settings.json
function restoreSettings() {
  if (fs.existsSync(TEMP_SETTINGS)) {
    fs.copyFileSync(TEMP_SETTINGS, SETTINGS_FILE);
    fs.unlinkSync(TEMP_SETTINGS);
    console.log("settings.json restored");
  }
}

// Restart via service if installed, otherwise start exe directly
function restartService() {
  // Check if service is installed
  let serviceInstalled = false;
  try {
    execSync(`sc query "${SERVICE_NAME}"`, { timeout: 5000 });
    serviceInstalled = true;
  } catch {
    // Service not installed
  }

  if (serviceInstalled) {
    try {
      console.log("Starting service...");
      execSync(`sc start "${SERVICE_NAME}"`, { timeout: 10000 });
      console.log("Service started");
    } catch (err) {
      console.error("Failed to start service:", err.message || err);
    }
    return;
  }

  // Service not installed, start exe directly
  console.log("Service not installed, starting exe directly...");
  const exePath = path.join(__dirname, "builds", "printerServer.exe");
  spawn(exePath, [], {
    detached: true,
    stdio: "ignore",
    cwd: path.join(__dirname, "builds"),
  }).unref();
}

// Main updater flow
function main() {
  try {
    stopService();
    killPort(7810);
    killPrinterServer();
    backupSettings();
    cleanDirectories();

    const zipUrl = getLatestZipUrl();
    downloadLatestZip(zipUrl);

    extractZip();
    restoreSettings();
    restartService();

    console.log("Update complete!");
  } catch (err) {
    console.error("Updater failed:", err);
  }
}

main();
