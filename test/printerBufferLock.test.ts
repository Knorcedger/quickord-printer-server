import { printer as ThermalPrinter } from 'node-thermal-printer';
import * as common from '../src/modules/common';
import {
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
});
