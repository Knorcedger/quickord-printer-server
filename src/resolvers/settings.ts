import { Request, Response } from 'express';
import signale from 'signale';

import { registerPrinterServerIp } from '../modules/api';
import logger from '../modules/logger';
import { syncModems } from '../modules/modem';
import { setupPrinters } from '../modules/printer';
import {
  getModems,
  getSettings,
  IPrinterSettings,
  saveSettings,
  Settings,
  stripSecrets,
  updateSettings,
} from '../modules/settings';

const settings = async (req: Request<{}, any, any>, res: Response<{}, any>) => {
  try {
    logger.info('Updating settings:', stripSecrets(req.body));

    const oldSettings = getSettings();

    // Venue guard: reject settings sync from a different venue
    const ownVenueId = oldSettings.venueId || getModems(oldSettings)[0]?.venueId;
    const incomingVenueId = req.body.venueId;
    const isFirstClaim = !ownVenueId && !!incomingVenueId;

    if (ownVenueId && incomingVenueId && incomingVenueId !== ownVenueId) {
      logger.warn(
        `Rejected settings sync from different venue: ${incomingVenueId} (own: ${ownVenueId})`
      );
      res.status(403).send({ error: 'venueId mismatch', ownVenueId });
      return;
    }

    const printers: IPrinterSettings[] = req.body.printers.map(
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
      ...req.body,
      printers,
      venueId: ownVenueId || incomingVenueId,
      wsSecret: req.body.wsSecret || oldSettings.wsSecret,
    });

    const modems = getModems(parsed);

    if (parsed.modems.some((m) => !m.port)) {
      signale.warn('Save settings was passed a modem without a port, ignored');
    }

    // Write the canonical list and keep the legacy single-modem mirror for one
    // release cycle, so a PS rollback doesn't wipe the venue's modem.
    const newSettings = {
      ...parsed,
      modem: modems[0] ?? undefined,
      modems,
    };

    updateSettings(newSettings);

    saveSettings();
    setupPrinters(newSettings);

    try {
      await syncModems(modems);
    } catch (modemError) {
      logger.error(
        'Failed to initialize modems, continuing without modem:',
        modemError
      );
    }

    // Never echo or log wsSecret: the FE already holds the value it pushed,
    // and the response/logs must not expose the credential.
    const safeSettings = stripSecrets(newSettings);

    logger.info('Settings updated:', safeSettings);

    res.status(200).send({ newSettings: safeSettings, status: 'updated' });

    if (isFirstClaim && newSettings.venueId) {
      await registerPrinterServerIp(newSettings.venueId);
    }

    // No explicit reconnect needed: the pull loop re-reads creds every iteration
    // and retries every NO_CREDS_RETRY_MS, so a secret sync takes effect on its
    // own without a process restart.
  } catch (error) {
    logger.error('Error updating settings:', error);
    res.status(400).send({ error: error.message });
  }
};

export default settings;
