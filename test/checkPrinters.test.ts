import { afterAll, describe, expect, it, vi } from 'vitest';
import { printer as ThermalPrinter } from 'node-thermal-printer';
import {
  checkPrinters,
  setupPrinters,
  stopPrinterKeepalive,
} from '../src/modules/printer';
import { enqueuePrinterJob } from '../src/modules/printerQueue';

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

describe('checkPrinters', () => {
  afterAll(async () => {
    stopPrinterKeepalive();
    vi.restoreAllMocks();
    // Let the inter-job pause drain so the worker exits cleanly.
    await new Promise((r) => setTimeout(r, 600));
  });

  it('reuses the last status instead of probing a printer mid-job', async () => {
    await setupPrinters({
      printers: [
        {
          characterSet: 'PC737_GREEK',
          documentsToPrint: ['TEXT'],
          id: 'p1',
          ip: '10.0.0.1',
          name: 'p1',
        },
      ],
    } as any);
    const probe = vi
      .spyOn(ThermalPrinter.prototype, 'isPrinterConnected')
      .mockResolvedValue(true);
    await checkPrinters();
    expect(probe).toHaveBeenCalledTimes(1);

    const job = deferred();
    enqueuePrinterJob('10.0.0.1', () => job.promise);
    probe.mockClear();
    const results = await checkPrinters();
    job.resolve();

    expect(probe).not.toHaveBeenCalled();
    expect(results).toEqual([{ id: 'p1', connected: true }]);
  });
});
