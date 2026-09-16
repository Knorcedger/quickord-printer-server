import { Request, Response } from 'express';

import { startPrinterServerIpRegistration } from '../modules/api';
import {
  applyDesiredSettings,
  VenueMismatchError,
} from '../modules/applySettings';
import logger from '../modules/logger';
import { stripSecrets } from '../modules/settings';

const settings = async (req: Request<{}, any, any>, res: Response<{}, any>) => {
  try {
    logger.info('Updating settings:', stripSecrets(req.body));

    // No hash: a LAN push is not the backend's desired state, so anything it
    // actually changes drops the stored hash and the next poll re-delivers.
    const { isFirstClaim, newSettings } = await applyDesiredSettings(req.body, {
      source: 'LAN POST /settings',
    });

    // Never echo or log wsSecret: the FE already holds the value it pushed,
    // and the response/logs must not expose the credential.
    const safeSettings = stripSecrets(newSettings);

    logger.info('Settings updated:', safeSettings);

    res.status(200).send({ newSettings: safeSettings, status: 'updated' });

    if (isFirstClaim && newSettings.venueId) {
      startPrinterServerIpRegistration(newSettings.venueId);
    }

    // No explicit reconnect needed: the pull loop re-reads creds every iteration
    // and retries every NO_CREDS_RETRY_MS, so a secret sync takes effect on its
    // own without a process restart.
  } catch (error) {
    if (error instanceof VenueMismatchError) {
      logger.warn(error.message);
      res
        .status(403)
        .send({ error: 'venueId mismatch', ownVenueId: error.ownVenueId });
      return;
    }

    logger.error('Error updating settings:', error);
    res.status(400).send({ error: error.message });
  }
};

export default settings;
