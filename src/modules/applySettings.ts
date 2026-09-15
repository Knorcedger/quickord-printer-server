/**
 * Applying a settings payload — from the backend's pull channel or from a LAN
 * POST /settings — is one operation with one set of rules. Lives here rather
 * than in settings.ts because it drives printers and modems, and those import
 * settings.ts.
 */
import logger from './logger';
import { syncModems } from './modem';
import { setupPrinters } from './printer';
import {
  getModems,
  getSettings,
  IModemSettings,
  IPrinterSettings,
  ISettings,
  saveSettings,
  Settings,
  settingsFingerprint,
  updateSettings,
} from './settings';

// A failed write leaves the live settings ahead of settings.json. Retry it on
// the next apply even when nothing changed — the file may have recovered since.
let persistPending = false;

/**
 * Write the live settings to settings.json, and on failure report no hash at
 * all. Falling back to the hash on disk would name settings the venue has
 * already stopped running: revert the backend to that state and it sees a
 * match, stops sending, and nothing is left to repair the live drift.
 */
const persist = async (): Promise<void> => {
  if (await saveSettings()) {
    persistPending = false;
    return;
  }

  persistPending = true;
  updateSettings({ ...getSettings(), syncedHash: undefined });
  logger.warn(
    'Could not write settings.json; not acknowledging the settings as synced'
  );
};

/** One modem that won't open must not fail the settings apply around it. */
const reconcileModems = async (modems: IModemSettings[]): Promise<void> => {
  try {
    await syncModems(modems);
  } catch (modemError) {
    logger.error(
      'Failed to initialize modems, continuing without modem:',
      modemError
    );
  }
};

export class VenueMismatchError extends Error {
  ownVenueId: string;

  constructor(ownVenueId: string, incomingVenueId: string) {
    super(
      `Rejected settings sync from different venue: ${incomingVenueId} (own: ${ownVenueId})`
    );
    this.ownVenueId = ownVenueId;
  }
}

/**
 * Merge a settings payload into what is on disk and put it into effect.
 * `hash` is the backend's, stored verbatim for the next poll to echo; without
 * one (a LAN push) the stored hash is dropped so the backend re-delivers —
 * unless the push changes nothing, which leaves the venue in sync as it was.
 * `authoritative` marks a payload that carries the venue's whole desired state
 * (the pull channel), where an absent field is a reset rather than an omission.
 */
export const applyDesiredSettings = async (
  incoming: any,
  options: { authoritative?: boolean; hash?: string; source: string }
): Promise<{ isFirstClaim: boolean; newSettings: ISettings }> => {
  const oldSettings = getSettings();

  // Venue guard: reject settings sync from a different venue
  const ownVenueId = oldSettings.venueId || getModems(oldSettings)[0]?.venueId;
  const incomingVenueId = incoming.venueId;
  const isFirstClaim = !ownVenueId && !!incomingVenueId;

  if (ownVenueId && incomingVenueId && incomingVenueId !== ownVenueId) {
    throw new VenueMismatchError(ownVenueId, incomingVenueId);
  }

  const printers: IPrinterSettings[] = incoming.printers.map(
    (printer: IPrinterSettings) => {
      // The schema rejects null outright, so neither marker can be passed
      // through: undefined means "not sent, keep what is local", null means the
      // field was cleared in the database and has to fall back to the schema
      // default instead of inheriting the local value.
      const entries = Object.entries(printer);
      const cleaned = Object.fromEntries(
        entries.filter(([, v]) => v !== undefined && v !== null)
      );
      const clearedKeys = entries
        .filter(([, v]) => v === null)
        .map(([key]) => key);
      const sanitizedIp =
        typeof printer.ip === 'string'
          ? printer.ip.replace('\r', '')
          : undefined;
      // Only a partial push merges onto the local printer. An authoritative one
      // must not: a field it omits is unset in the database, and carrying the
      // local value over would leave drift the acknowledged hash calls in sync.
      const local = options.authoritative
        ? {}
        : oldSettings.printers.find(
            (p) =>
              (sanitizedIp !== undefined &&
                p.ip === sanitizedIp &&
                p.ip !== '') ||
              (p.port === printer.port && p.port !== '')
          ) || {};
      const merged: Record<string, unknown> = {
        ...local,
        ...cleaned,
        ...(sanitizedIp !== undefined ? { ip: sanitizedIp } : {}),
      };

      clearedKeys.forEach((key) => delete merged[key]);

      return merged as IPrinterSettings;
    }
  );

  // Force own venueId — accept first time, lock after.
  // Preserve an existing wsSecret if a sync omits it, so a stale FE push
  // can't wipe the secret already on disk.
  const parsed = Settings.parse({
    ...incoming,
    printers,
    syncedHash: options.hash,
    venueId: ownVenueId || incomingVenueId,
    wsSecret: incoming.wsSecret || oldSettings.wsSecret,
  });

  const modems = getModems(parsed);

  if (parsed.modems.some((m) => !m.port)) {
    logger.warn('Save settings was passed a modem without a port, ignored');
  }

  // Write the canonical list and keep the legacy single-modem mirror for one
  // release cycle, so a PS rollback doesn't wipe the venue's modem. Old
  // builds read venueId off the modem itself, so the mirror must carry it.
  const newSettings = {
    ...parsed,
    modem: modems[0]
      ? { ...modems[0], venueId: modems[0].venueId ?? parsed.venueId ?? '' }
      : undefined,
    modems,
  };

  // A push that changes nothing still arrives on every page mount and after
  // every LAN push (the backend re-delivers what it sees as unsynced). Record
  // the hash and skip setupPrinters: rebuilding identical printer handles only
  // churns them.
  if (settingsFingerprint(newSettings) === settingsFingerprint(oldSettings)) {
    const hash = options.hash ?? oldSettings.syncedHash;

    // persistPending: an earlier write failed, so settings.json is behind even
    // though this payload changes nothing. This is the retry.
    if (hash !== oldSettings.syncedHash || persistPending) {
      updateSettings({ ...oldSettings, syncedHash: hash });
      await persist();
    }

    // Modems still reconcile: one whose reconnect attempts ran out stays dead
    // until something reopens it, and an unchanged push is what the venue has
    // to reach for. syncModems leaves open and reconnecting ports untouched,
    // so only the dead ones are revived.
    await reconcileModems(modems);

    logger.info(`Settings unchanged from ${options.source}`);

    return { isFirstClaim, newSettings: getSettings() };
  }

  updateSettings(newSettings);

  await persist();
  setupPrinters(newSettings);
  await reconcileModems(modems);

  logger.info(`Settings applied from ${options.source}`);

  return { isFirstClaim, newSettings };
};
