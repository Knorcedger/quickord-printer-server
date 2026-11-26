/**
 * Per-printer job queue for pull jobs (printJob.ts). checkPrinters and the
 * keep-alive read it so they never probe a printer mid-job.
 */
import logger from './logger';

// Thermal printers accept a single connection at a time, so two overlapping
// jobs to one device (copies, or two independent print requests at once)
// collide and only one ticket comes out. Chaining each job onto the previous
// one for that printer serializes them; distinct printers still print in
// parallel.
const printerQueues = new Map<string, Promise<void>>();

// Pause between chained jobs to the same printer, giving it time to finish
// cutting/feeding before the next connection opens — a send resolves on
// socket close, not print completion, so back-to-back connects would hit some
// printer models mid-cut.
const INTER_JOB_DELAY_MS = 500;

export function enqueuePrinterJob(
  key: string,
  task: () => Promise<void>
): void {
  const prev = printerQueues.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(task)
    .catch((err) => {
      // Callers report their own failures, so a rejection surfacing here is an
      // unexpected fault. Log it and keep the chain alive for queued jobs.
      logger.error(`Unexpected error in printer queue for ${key}:`, err);
    })
    .then(() => new Promise<void>((r) => setTimeout(r, INTER_JOB_DELAY_MS)));
  printerQueues.set(key, next);
  // Drop the entry once it settles, unless a newer job has already chained on.
  void next.finally(() => {
    if (printerQueues.get(key) === next) printerQueues.delete(key);
  });
}

// True while a job for `key` is running or waiting (incl. the inter-job pause).
export function hasPendingPrinterJob(key: string): boolean {
  return printerQueues.has(key);
}
