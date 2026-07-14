/**
 * Resolves how many copies of a document a printer should produce.
 * Copies are configured per document type, per printer (`documentCopies`).
 * Mirrors quickord-be/modules/printing/copies.ts.
 */
import { IPrinterSettings } from './settings';

const MIN_COPIES = 1;
const MAX_COPIES = 10;

/**
 * How many times to print `document` (an entry of `documentsToPrint`, e.g.
 * ORDER, ALP, PARKING-TICKET) on this printer.
 *
 * Legacy fallback: before `documentCopies` existed, the per-printer `copies`
 * field applied only to orders and parking tickets. Printers that have not been
 * saved since keep that behaviour.
 */
export const resolveCopies = (
  settings: Pick<IPrinterSettings, 'copies' | 'documentCopies'>,
  document: string
): number => {
  const entry = settings.documentCopies?.find((d) => d.document === document);
  if (entry) {
    return toValidCopyCount(entry.copies);
  }

  if (settings.documentCopies?.length) {
    return MIN_COPIES;
  }

  return document === 'ORDER' || document === 'PARKING-TICKET'
    ? toValidCopyCount(settings.copies)
    : MIN_COPIES;
};

/**
 * Coerce a configured value into a printable copy count, falling back to 1 for
 * anything invalid.
 */
const toValidCopyCount = (value: unknown): number => {
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count) || count < MIN_COPIES) {
    return MIN_COPIES;
  }
  return Math.min(count, MAX_COPIES);
};
