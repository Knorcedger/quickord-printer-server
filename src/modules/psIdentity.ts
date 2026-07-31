/**
 * Printer-server identity and control helpers.
 *
 * Small, dependency-light accessors shared across the app: the venue this
 * server is provisioned for, its per-venue secret, the current version, and the
 * restart trigger. Kept apart from the transport modules so both the pull client
 * and the HTTP resolvers can import them without a cycle.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import nconf from 'nconf';
import logger from './logger';

// Current PS version from the `version` file at the app root. Reported in the
// pull poll body so the backend can surface current-vs-latest version info.
export function getPrinterVersion(): string {
  // Read cwd-relative first, exactly like autoupdate.ts: the packaged nexe exe's
  // __dirname points into the virtual snapshot FS and misses the real `version`
  // file sitting next to the exe, so the __dirname path throws in the Windows
  // service and we'd report 'unknown'. Fall back to __dirname for a plain
  // node-from-dist dev run, then to 'unknown' only if both fail.
  try {
    return fs.readFileSync('version', 'utf-8').trim();
  } catch {
    try {
      return fs
        .readFileSync(path.join(__dirname, '../../version'), 'utf-8')
        .trim();
    } catch {
      return 'unknown';
    }
  }
}

// Get registered venueId from in-memory settings object.
export function getVenueId(): string {
  try {
    const { getSettings } = require('./settings');
    const settings = getSettings();
    if (settings?.venueId) return settings.venueId;
    if (settings?.modem?.venueId) return settings.modem.venueId;
  } catch {}
  return nconf.get('VENUE_ID') || '';
}

// Per-venue secret authenticating this server to the backend. Stored in
// settings.json (synced DB -> local by the frontend, same path as venueId), with
// an env fallback for manual provisioning. Fail-closed: no hardcoded fallback,
// so a leaked shared key can no longer impersonate other venues.
export function getWsSecret(): string {
  try {
    const { getSettings } = require('./settings');
    const secret = getSettings()?.wsSecret;
    if (secret) return secret;
  } catch {}
  return nconf.get('VENUE_WS_SECRET') || '';
}

// Restart trigger registered by index.ts, which owns the http server instance
// and the spawn-new-process logic. Called when the backend sends a restart
// command over the pull channel, so a restart can be triggered remotely.
let restartHandler: (() => void) | null = null;

export function setRestartHandler(fn: () => void): void {
  restartHandler = fn;
}

// Invoke the registered restart trigger. Called by the long-poll pull client's
// restart command. No-ops (with a warning) if index.ts never wired one.
export function triggerRestart(): void {
  if (restartHandler) {
    restartHandler();
  } else {
    logger.warn('No restart handler registered, ignoring restart request');
  }
}
