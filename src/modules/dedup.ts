import crypto from 'node:crypto';

import { NextFunction, Request, Response } from 'express';

import logger from './logger';

const DEDUP_WINDOW_MS = 30_000;
const MAX_CACHE_SIZE = 500;

const printCache = new Map<string, number>();

const evictExpired = () => {
  if (printCache.size > MAX_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of printCache) {
      if (now - v > DEDUP_WINDOW_MS) {
        printCache.delete(k);
      }
    }
  }
};

/**
 * Express middleware that deduplicates print requests.
 * Uses endpoint path + body hash as the dedup key.
 * Requests with identical bodies to the same endpoint within 30s are skipped.
 */
export const dedup = (req: Request, res: Response, next: NextFunction) => {
  const bodyHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(req.body))
    .digest('hex')
    .slice(0, 16);

  const key = `${req.path}:${bodyHash}`;
  const now = Date.now();
  const lastPrinted = printCache.get(key);

  if (lastPrinted && now - lastPrinted < DEDUP_WINDOW_MS) {
    logger.info(
      `Dedup: skipping duplicate request for ${req.path} age=${now - lastPrinted}ms`
    );
    res.status(200).send({
      status: 'skipped',
      reason: 'duplicate request',
    });
    return;
  }

  printCache.set(key, now);
  evictExpired();

  next();
};
