// updater.js
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip/adm-zip.js");

const BUILD_DIR = path.join(__dirname, "builds");
const SETTINGS_FILE = path.join(BUILD_DIR, "settings.json");
const TEMP_SETTINGS = path.join(__dirname, "settings_backup.json");
const ZIP_PATH = path.join(__dirname, "latest.zip");

// Kill process on port
function killPort(port) {
  try {
    console.log(`Killing process on port ${port}...`);
    execSync(
      `for /f "tokens=5" %a in ('netstat -ano ^| find ":${port}" ^| find "LISTENING"') do taskkill /PID %a /F`
    );
  } catch {
    console.warn(`No process found on port ${port}`);
  }
}

// Backup settings.json
function backupSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    fs.copyFileSync(SETTINGS_FILE, TEMP_SETTINGS);
    console.log("✅ settings.json backed up");
  } else {
    console.log("⚠️ settings.json not found to backup");
  }
}

// Clean builds folder
function cleanDirectories() {
  if (fs.existsSync(BUILD_DIR))
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  console.log("🧹 Cleaned builds folder");
}

// Get latest GitHub release zip URL via curl + JSON parsing
function getLatestZipUrl() {
  console.log("🌐 Fetching latest release URL...");
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
  console.log("⬇️ Downloading:", url);
  try {
    execSync(`curl -L -o "${ZIP_PATH}" "${url}"`, { stdio: "inherit" });
  } catch (err) {
    throw new Error("Download failed");
  }
}

// Extract zip
function extractZip() {
  console.log("📦 Extracting zip...");
  const zip = new AdmZip(ZIP_PATH);
  zip.extractAllTo(__dirname, true);
  fs.unlinkSync(ZIP_PATH);
  console.log("✅ Extraction done");
}

// Restore settings.json
function restoreSettings() {
  if (fs.existsSync(TEMP_SETTINGS)) {
    fs.copyFileSync(TEMP_SETTINGS, SETTINGS_FILE);
    fs.unlinkSync(TEMP_SETTINGS);
    console.log("✅ settings.json restored");
  }
}

// Restart main service
function restartService() {
  console.log("🚀 Restarting main service...");
  spawn("node", ["builds/index.js"], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

// Main updater flow
function main() {
  try {
    killPort(7810);
    backupSettings();
    cleanDirectories();

    const zipUrl = getLatestZipUrl();
    downloadLatestZip(zipUrl);

    extractZip();
    restoreSettings();
    restartService();

    console.log("🎉 Update complete!");
  } catch (err) {
    console.error("❌ Updater failed:", err);
  }
}

main();
