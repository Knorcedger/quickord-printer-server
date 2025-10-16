// scripts/create_version_file.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Fix __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper: pad number to 2 digits
function pad2(n) {
  return n.toString().padStart(2, '0');
}

// Path to version file
const versionFile = path.join(__dirname, '..', 'version');

// Read previous counter if exists
let lastCounter = 0;
if (fs.existsSync(versionFile)) {
  const lastVersion = fs.readFileSync(versionFile, 'utf-8').trim();
  const parts = lastVersion.split('-');
  if (parts[1]) lastCounter = parseInt(parts[1], 10);
}

// Get current date
const now = new Date();
const datePart = `v${now.getFullYear()}.${pad2(now.getMonth() + 1)}.${pad2(now.getDate())}`;

// Increment counter
const newCounter = lastCounter + 1;

// Build new version string
const version = `${datePart}-${newCounter.toString().padStart(6, '0')}`;

// Save to file
fs.writeFileSync(versionFile, version);

console.log('New version:', version);
