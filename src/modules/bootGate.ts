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

const startedAt = Date.now();
let polled = false;

export const markFirstPoll = (): void => {
  if (polled) return;
  polled = true;
  logger.info(
    `Print routes open after first poll (${Date.now() - startedAt}ms)`
  );
};

export const isPrintReady = (): boolean =>
  polled || Date.now() - startedAt >= BOOT_GATE_MAX_MS;

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
