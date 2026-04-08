import { Request, Response } from 'express';
import signale from 'signale';

import logger from '../modules/logger';
import { createModem } from '../modules/modem';
import { setupPrinters } from '../modules/printer';
import {
  getSettings,
  IPrinterSettings,
  saveSettings,
  Settings,
  updateSettings,
} from '../modules/settings';

const settings = async (req: Request<{}, any, any>, res: Response<{}, any>) => {
  try {
    logger.info('Updating settings:', req.body);

    const oldSettings = getSettings();

    // Venue guard: reject settings sync from a different venue
    const ownVenueId = oldSettings.venueId || oldSettings.modem?.venueId;
    const incomingVenueId = req.body.venueId;

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
        return {
          ...(oldSettings.printers.find(
            (p) =>
              (p.ip === printer.ip?.replace('\r', '') && p.ip !== '') ||
              (p.port === printer.port && p.port !== '')
          ) || {}),
          ...cleaned,
          ip: printer.ip ? printer.ip.replace('\r', '') : undefined,
        };
      }
    );

    // Force own venueId — accept first time, lock after
    const newSettings = Settings.parse({
      ...req.body,
      printers,
      venueId: ownVenueId || incomingVenueId,
    });

    // Force 58mm paper width for specific venues
    const VENUES_58MM = ['69ce72b461628d1bfbc00d6f'];
    const effectiveVenueId = newSettings.venueId || newSettings.modem?.venueId;
    if (effectiveVenueId && VENUES_58MM.includes(effectiveVenueId)) {
      newSettings.printers = newSettings.printers.map((p) => ({
        ...p,
        paperWidth: '58' as const,
      }));
    }

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

    logger.info('Settings updated:', newSettings);

    res.status(200).send({ newSettings, status: 'updated' });
  } catch (error) {
    logger.error('Error updating settings:', error);
    res.status(400).send({ error: error.message });
  }
};

export default settings;
