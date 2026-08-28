import crypto from 'node:crypto';

import { NextFunction, Request, Response } from 'express';

import logger from './logger';

const DEDUP_WINDOW_MS = 30_000;
const MAX_CACHE_SIZE = 500;

const printCache = new Map<string, number>();

// Normalize the sending device's identity. Routing only ever distinguishes
// `kiosk` from everything else (KIOSK-type printers print only for kiosk
// requests — see printer.ts), so desktop / mobile / customer / tiko all produce
// the exact same physical output. Collapsing them to one token lets a print
// sent by two stations (e.g. a desktop and a mobile both reacting to the same
// order broadcast) dedup against each other, while a genuinely different kiosk
// print stays distinct.
const normalizeAppId = (v: unknown): string => (v === 'kiosk' ? 'kiosk' : 'app');

// Build a canonical string for the request body that ignores the things that
// differ between two stations printing the *same* document but not between two
// genuinely different prints:
//   - object key ordering (different client payload builders may emit keys in a
//     different order, which would change a naive JSON.stringify hash), and
//   - the `appId` device identity (normalized above).
// This only feeds the dedup fingerprint — req.body is never mutated, so the
// printed output and its field order are unaffected. Everything that affects
// what is actually printed (products, totals, order id, isEdit, etc.) is
// preserved, so distinct documents still hash differently.
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .map((k) => {
      const raw = obj[k];
      const v = k === 'appId' ? normalizeAppId(raw) : raw;
      return `${JSON.stringify(k)}:${canonicalize(v)}`;
    });
  return `{${parts.join(',')}}`;
};

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
    .update(canonicalize(req.body))
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
