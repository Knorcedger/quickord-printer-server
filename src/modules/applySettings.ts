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
  IPrinterSettings,
  ISettings,
  saveSettings,
  Settings,
  updateSettings,
} from './settings';

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
 * one (a LAN push) the stored hash is dropped so the backend re-delivers.
 */
export const applyDesiredSettings = async (
  incoming: any,
  options: { hash?: string; source: string }
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
      // Strip undefined values so they don't overwrite existing settings
      const cleaned = Object.fromEntries(
        Object.entries(printer).filter(([, v]) => v !== undefined)
      );
      const sanitizedIp =
        printer.ip !== undefined ? printer.ip.replace('\r', '') : undefined;
      return {
        ...(oldSettings.printers.find(
          (p) =>
            (sanitizedIp !== undefined &&
              p.ip === sanitizedIp &&
              p.ip !== '') ||
            (p.port === printer.port && p.port !== '')
        ) || {}),
        ...cleaned,
        ...(sanitizedIp !== undefined ? { ip: sanitizedIp } : {}),
      };
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

  updateSettings(newSettings);

  await saveSettings();
  setupPrinters(newSettings);

  try {
    await syncModems(modems);
  } catch (modemError) {
    logger.error(
      'Failed to initialize modems, continuing without modem:',
      modemError
    );
  }

  logger.info(`Settings applied from ${options.source}`);

  return { isFirstClaim, newSettings };
};
