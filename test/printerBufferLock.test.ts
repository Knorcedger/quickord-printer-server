import { printer as ThermalPrinter } from 'node-thermal-printer';
import * as common from '../src/modules/common';
import {
  checkPrinters,
  printOrdersComments,
  printText,
  setupPrinters,
  stopPrinterKeepalive,
} from '../src/modules/printer';
import { enqueuePrinterJob } from '../src/modules/printerQueue';

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

const flush = () => new Promise((r) => setImmediate(r));

describe('LAN prints sharing a printer buffer', () => {
  const sent: string[] = [];

  beforeAll(async () => {
    jest
      .spyOn(ThermalPrinter.prototype, 'raw')
      .mockImplementation(async (data: Buffer) => {
        sent.push(Buffer.from(data).toString('latin1'));
        return '';
      });
    await setupPrinters({
      printers: [
        {
          characterSet: 'PC737_GREEK',
          documentsToPrint: ['TEXT', 'COMMENTS'],
          ip: '10.0.0.9',
          name: 'bar',
        },
      ],
    } as any);
  });

  afterAll(async () => {
    stopPrinterKeepalive();
    jest.restoreAllMocks();
    // Let the inter-job pauses drain so the worker exits cleanly.
    await new Promise((r) => setTimeout(r, 600));
  });

  it("keeps a rendering request's bytes when a queued one finishes", async () => {
    const pullJob = deferred();
    const image = deferred();
    jest
      .spyOn(common, 'readMarkdown')
      .mockImplementation(async (_text, printer) => {
        printer.println('B-HEADER');
        await image.promise;
        printer.println('B-BODY');
      });

    // A renders, then waits behind a pull job; B starts while A is queued.
    enqueuePrinterJob('10.0.0.9', () => pullJob.promise);
    const a = printOrdersComments([
      {
        _id: 'a',
        createdAt: new Date().toISOString(),
        number: 1,
        orderType: 'DELIVERY',
        waiterComment: 'A-NOTE',
      } as any,
    ]);
    await flush();
    const res = { send: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    const b = printText({ body: { text: 'x' } } as any, res as any);
    await flush();

    pullJob.resolve();
    await a;
    image.resolve();
    await b;

    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('A-NOTE');
    expect(sent[0]).not.toContain('B-HEADER');
    expect(sent[1]).toContain('B-HEADER');
    expect(sent[1]).toContain('B-BODY');
  });

  it('does not wait on a busy printer it is going to skip', async () => {
    await setupPrinters({
      printers: [
        {
          characterSet: 'PC737_GREEK',
          documentsToPrint: ['TEXT'],
          ip: '10.0.0.1',
          name: 'p1',
        },
        {
          characterSet: 'PC737_GREEK',
          documentsToPrint: ['COMMENTS'],
          ip: '10.0.0.2',
          name: 'p2',
        },
      ],
    } as any);
    sent.length = 0;
    const image = deferred();
    jest
      .spyOn(common, 'readMarkdown')
      .mockImplementation(async (_text, printer) => {
        printer.println('A-TEXT');
        await image.promise;
      });

    // A holds p1 mid-render; B's comments only go to p2.
    const res = { send: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    const a = printText({ body: { text: 'x' } } as any, res as any);
    await flush();
    const b = printOrdersComments([
      {
        _id: 'b',
        createdAt: new Date().toISOString(),
        number: 2,
        orderType: 'DELIVERY',
        waiterComment: 'B-NOTE',
      } as any,
    ]);
    const bFinishedFirst = await Promise.race([
      b.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
    ]);
    image.resolve();
    await Promise.all([a, b]);

    expect(bFinishedFirst).toBe(true);
    expect(sent[0]).toContain('B-NOTE');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('A-TEXT');
  });

  it('reports a refused socket on a text print as a connection failure', async () => {
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
    jest.spyOn(common, 'readMarkdown').mockResolvedValue(undefined);
    jest
      .mocked(ThermalPrinter.prototype.raw)
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1:9100'));

    const res = { send: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    await printText({ body: { text: 'x' } } as any, res as any);

    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('Failed to connect to printer: p1'),
      })
    );
  });

  it('reuses the last status instead of probing a printer mid-job', async () => {
    const probe = jest
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
