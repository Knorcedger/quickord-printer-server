import { Request, Response } from 'express';
import signale from 'signale';

import { registerPrinterServerIp } from '../modules/api';
import logger from '../modules/logger';
import { createModem } from '../modules/modem';
import { setupPrinters } from '../modules/printer';
import { reconnectWebSocketClient } from '../modules/wsClient';
import {
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
    const ownVenueId = oldSettings.venueId || oldSettings.modem?.venueId;
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
    const newSettings = Settings.parse({
      ...req.body,
      printers,
      venueId: ownVenueId || incomingVenueId,
      wsSecret: req.body.wsSecret || oldSettings.wsSecret,
    });

    updateSettings(newSettings);

    saveSettings();
    setupPrinters(newSettings);

    if (newSettings.modem) {
      if (newSettings.modem.port && newSettings.modem.venueId) {
        try {
          await createModem(newSettings.modem);
        } catch (modemError) {
          logger.error(
            'Failed to initialize modem, continuing without modem:',
            modemError
          );
        }
      } else {
        signale.warn('Save settings was passed bad data for modem: ', {
          port: newSettings.modem.port,
          venueId: newSettings.modem.venueId,
        });
      }
    }

    // Never echo or log wsSecret: the FE already holds the value it pushed,
    // and the response/logs must not expose the credential.
    const safeSettings = stripSecrets(newSettings);

    logger.info('Settings updated:', safeSettings);

    res.status(200).send({ newSettings: safeSettings, status: 'updated' });

    if (isFirstClaim && newSettings.venueId) {
      await registerPrinterServerIp(newSettings.venueId);
    }

    // Register over WS now that venueId + wsSecret are on disk, so the secret
    // sync doesn't require a process restart to take effect. Self-guards, so a
    // same-creds resync is a no-op.
    reconnectWebSocketClient();
  } catch (error) {
    logger.error('Error updating settings:', error);
    res.status(400).send({ error: error.message });
  }
};

export default settings;
