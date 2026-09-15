/**
 * Print routes answer 503 until the first successful poll, so a PS that boots
 * with settings the backend has already replaced doesn't print one job with the
 * old config. The 15s cap is mandatory: on a boot with a dead uplink the poll
 * never succeeds, and the LAN fallback — which exists for exactly that case —
 * must not be gated out with it.
 */
import { NextFunction, Request, Response } from 'express';

import logger from './logger';

const BOOT_GATE_MAX_MS = 15_000;

// Starts when the server listens, not at import: the auto-update check and the
// modem and printer setup run before that, and a slow one would burn the whole
// window before the first poll was even attempted.
let startedAt: number | undefined;
let polled = false;

export const startBootGate = (): void => {
  startedAt = Date.now();
};

export const markFirstPoll = (): void => {
  if (polled) return;
  polled = true;
  logger.info(
    `Print routes open after first poll (${Date.now() - (startedAt ?? Date.now())}ms)`
  );
};

export const isPrintReady = (): boolean =>
  polled ||
  (startedAt !== undefined && Date.now() - startedAt >= BOOT_GATE_MAX_MS);

export const bootGate = (
  req: Request<{}, any, any>,
  res: Response<{}, any>,
  next: NextFunction
): void => {
  if (isPrintReady()) {
    next();
    return;
  }

  res.status(503).send({ status: 'starting' });
};
