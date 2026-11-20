import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { printer as ThermalPrinter } from 'node-thermal-printer';
import * as common from '../src/modules/common';
import {
  BUZZER_BYTES,
  printText,
  setupPrinters,
  stopPrinterKeepalive,
} from '../src/modules/printer';

vi.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const sent: Buffer[] = [];

const startsWithBuzzer = (data: Buffer) =>
  data.subarray(0, BUZZER_BYTES.length).equals(BUZZER_BYTES);

const printTwoCopies = async () => {
  sent.length = 0;
  const res = { send: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  await printText({ body: { copies: 2, text: 'x' } } as any, res as any);
};

const setup = (buzzerEnabled: boolean) =>
  setupPrinters({
    printers: [
      {
        buzzerEnabled,
        characterSet: 'PC737_GREEK',
        documentsToPrint: ['TEXT'],
        ip: '10.0.0.8',
        name: 'bar',
      },
    ],
  } as any);

describe('buzzer before a LAN print', () => {
  beforeAll(() => {
    vi.spyOn(ThermalPrinter.prototype, 'raw').mockImplementation(
      async (data: Buffer) => {
        sent.push(Buffer.from(data));
        return '';
      }
    );
    vi.spyOn(common, 'readMarkdown').mockImplementation(
      async (_text, printer) => {
        printer.println('BODY');
      }
    );
  });

  afterAll(async () => {
    stopPrinterKeepalive();
    vi.restoreAllMocks();
    await new Promise((r) => setTimeout(r, 600));
  });

  it('beeps before the first copy only', async () => {
    await setup(true);
    await printTwoCopies();
    expect(sent.map(startsWithBuzzer)).toEqual([true, false]);
  });

  it('sends no buzzer bytes when off', async () => {
    await setup(false);
    await printTwoCopies();
    expect(sent.map(startsWithBuzzer)).toEqual([false, false]);
  });
});
