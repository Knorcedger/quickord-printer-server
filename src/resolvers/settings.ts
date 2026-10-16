import { Request, Response } from 'express';

import { startPrinterServerIpRegistration } from '../modules/api';
import {
  applyBootstrapIdentity,
  VenueMismatchError,
} from '../modules/applySettings';
import logger from '../modules/logger';

// LAN bootstrap only: the venue identity and wsSecret a PS needs before it can
// poll. Printers and modems come over the pull channel, never from here.
const settings = async (req: Request<{}, any, any>, res: Response<{}, any>) => {
  try {
    const { isFirstClaim, venueId } = await applyBootstrapIdentity(
      req.body ?? {}
    );

    // Never log or echo wsSecret.
    logger.info('Bootstrap identity accepted over the LAN', {
      isFirstClaim,
      venueId,
    });

    res.status(200).send({ status: 'updated', venueId });

    if (isFirstClaim) startPrinterServerIpRegistration(venueId);

    // No explicit reconnect needed: the pull loop re-reads creds every iteration
    // and retries every NO_CREDS_RETRY_MS, so the secret takes effect on its own.
  } catch (error) {
    if (error instanceof VenueMismatchError) {
      logger.warn(error.message);
      res
        .status(403)
        .send({ error: 'venueId mismatch', ownVenueId: error.ownVenueId });
      return;
    }

    logger.error('Error applying bootstrap identity:', error);
    res.status(400).send({ error: error.message });
  }
};

export default settings;
