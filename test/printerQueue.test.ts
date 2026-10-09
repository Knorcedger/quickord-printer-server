import { enqueuePrinterJob, runOnPrinterQueue } from '../src/modules/printerQueue';

jest.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('printer queue', () => {
  // Let the inter-job pauses drain so the worker exits cleanly.
  afterAll(() => new Promise((r) => setTimeout(r, 600)));

  it('runs an awaited job only after the queued pull job on the same printer', async () => {
    const order: string[] = [];
    const pullJob = deferred();

    enqueuePrinterJob('10.0.0.5', async () => {
      order.push('pull:start');
      await pullJob.promise;
      order.push('pull:end');
    });
    const lan = runOnPrinterQueue('10.0.0.5', async () => {
      order.push('lan');
    });

    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['pull:start']);

    pullJob.resolve();
    await lan;
    expect(order).toEqual(['pull:start', 'pull:end', 'lan']);
  });

  it('does not hold up a different printer', async () => {
    const blocker = deferred();
    enqueuePrinterJob('10.0.0.6', () => blocker.promise);

    await expect(runOnPrinterQueue('10.0.0.7', async () => 'ok')).resolves.toBe(
      'ok'
    );
    blocker.resolve();
  });

  it('rejects to the caller and keeps the chain alive', async () => {
    await expect(
      runOnPrinterQueue('10.0.0.8', async () => {
        throw new Error('Socket timeout');
      })
    ).rejects.toThrow('Socket timeout');

    await expect(runOnPrinterQueue('10.0.0.8', async () => 'next')).resolves.toBe(
      'next'
    );
  });
});
