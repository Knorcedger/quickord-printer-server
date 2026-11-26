import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  enqueuePrinterJob,
  hasPendingPrinterJob,
} from '../src/modules/printerQueue';

vi.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// Resolves once `task` has run on the queue.
const enqueueAndWait = (key: string, task: () => Promise<void>) =>
  new Promise<void>((resolve) => {
    enqueuePrinterJob(key, () => task().finally(resolve));
  });

describe('printer queue', () => {
  // Let the inter-job pauses drain so the worker exits cleanly.
  afterAll(() => new Promise((r) => setTimeout(r, 600)));

  it('runs a second job only after the first on the same printer', async () => {
    const order: string[] = [];
    const first = deferred();

    enqueuePrinterJob('10.0.0.5', async () => {
      order.push('first:start');
      await first.promise;
      order.push('first:end');
    });
    const second = enqueueAndWait('10.0.0.5', async () => {
      order.push('second');
    });

    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['first:start']);

    first.resolve();
    await second;
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('does not hold up a different printer', async () => {
    const blocker = deferred();
    enqueuePrinterJob('10.0.0.6', () => blocker.promise);

    await expect(
      enqueueAndWait('10.0.0.7', async () => {})
    ).resolves.toBeUndefined();
    blocker.resolve();
  });

  it('keeps the chain alive after a failed job', async () => {
    enqueuePrinterJob('10.0.0.8', async () => {
      throw new Error('Socket timeout');
    });

    let ran = false;
    await enqueueAndWait('10.0.0.8', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe('hasPendingPrinterJob', () => {
  it('is true while a job runs and false once the queue drains', async () => {
    vi.useFakeTimers();
    try {
      const job = deferred();
      enqueuePrinterJob('10.0.0.7', () => job.promise);
      expect(hasPendingPrinterJob('10.0.0.7')).toBe(true);
      expect(hasPendingPrinterJob('10.0.0.8')).toBe(false);

      job.resolve();
      await vi.runAllTimersAsync();
      expect(hasPendingPrinterJob('10.0.0.7')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
