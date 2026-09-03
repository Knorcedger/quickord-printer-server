import logger from './logger';

const DEFAULT_SUMMARY_INTERVAL_MS = 5 * 60 * 1000;

const minutesSince = (t: number): number =>
  Math.round((Date.now() - t) / 60_000);

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Collapses a sustained failure episode into three kinds of log line: the first
 * failure in full, one summary per interval while it lasts, one on recovery.
 * A 13h outage otherwise wrote 18MB of near-identical stack traces.
 */
export class FailureEpisode {
  private readonly label: string;

  private readonly summaryIntervalMs: number;

  private failures = 0;

  private startedAt = 0;

  private lastSummaryAt = 0;

  constructor(label: string, summaryIntervalMs = DEFAULT_SUMMARY_INTERVAL_MS) {
    this.label = label;
    this.summaryIntervalMs = summaryIntervalMs;
  }

  // True while an episode is in progress: callers pass it down to suppress
  // their own per-attempt dumps, whose first copy is already in the log.
  get active(): boolean {
    return this.failures > 0;
  }

  get failureCount(): number {
    return this.failures;
  }

  fail(err: unknown): void {
    const now = Date.now();
    this.failures += 1;

    if (this.failures === 1) {
      this.startedAt = now;
      this.lastSummaryAt = now;
      logger.error(`${this.label} failed:`, err);
      return;
    }

    if (now - this.lastSummaryAt < this.summaryIntervalMs) return;
    this.lastSummaryAt = now;
    logger.error(
      `${this.label} still failing — ${this.failures} consecutive failures over ${minutesSince(this.startedAt)}m. Last error: ${messageOf(err)}`
    );
  }

  succeed(): void {
    if (this.failures > 0) {
      logger.info(
        `${this.label} recovered after ${this.failures} failures over ${minutesSince(this.startedAt)}m`
      );
    }
    this.failures = 0;
  }

  // Drop the streak without a recovery line: a different kind of failure took
  // over and must not inflate the next episode's count.
  reset(): void {
    this.failures = 0;
  }
}
