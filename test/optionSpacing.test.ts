import { describe, expect, test, vi } from 'vitest';
import {
  CharacterSet,
  printer as ThermalPrinter,
  types as PrinterTypes,
} from 'node-thermal-printer';
import { installCharsetGuard } from '../src/modules/charsetGuard';
import {
  OPTION_GAP_DOTS,
  printOptionDetails,
  printProducts,
} from '../src/modules/common';

vi.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const GAP = Buffer.from([0x1b, 0x4a, OPTION_GAP_DOTS]);

const makePrinter = () => {
  const characterSet = CharacterSet.PC737_GREEK;
  return installCharsetGuard(
    new ThermalPrinter({
      characterSet,
      interface: {
        execute: async (buffer: Buffer) => buffer,
        isPrinterConnected: async () => true,
      } as any,
      type: PrinterTypes.EPSON,
    }),
    characterSet
  );
};

const gapOffsets = (buf: Buffer): number[] => {
  const out: number[] = [];
  for (let i = buf.indexOf(GAP); i !== -1; i = buf.indexOf(GAP, i + 1))
    out.push(i);
  return out;
};

const choice = (title: string) => ({
  content: [{ language: 'en', title }],
});

// The second option wraps over several lines at 42 cells.
const OPTIONS: any[] = [
  { choices: [choice('gouda')], content: [{ language: 'en', title: 'Cheese' }] },
  {
    choices: [
      'tomato',
      'lettuce',
      'onion',
      'pickles',
      'mushrooms',
      'peppers',
      'olives',
    ].map(choice),
    content: [{ language: 'en', title: 'Vegetables' }],
  },
  { choices: [choice('ketchup')], content: [{ language: 'en', title: 'Sauce' }] },
];

const settings: any = { optionDetails: true, transliterate: false };

describe('optionSpacing on order tickets', () => {
  test('feeds one gap before each option, none inside a wrapped option', () => {
    const printer = makePrinter();
    const println = vi.spyOn(printer, 'println');
    // The count gates the gap before a product comment.
    expect(
      printOptionDetails(printer, OPTIONS, 'en', settings, false, true)
    ).toBe(OPTIONS.length);

    expect(println.mock.calls.length).toBeGreaterThan(OPTIONS.length);
    const buf = printer.getBuffer();
    const gaps = gapOffsets(buf);
    expect(gaps).toHaveLength(OPTIONS.length);
    // Each gap falls between the previous option and its own label.
    const labels = ['CHEESE', 'VEGETABLES', 'SAUCE'].map((l) => buf.indexOf(l));
    labels.forEach((at, i) => {
      expect(gaps[i]).toBeLessThan(at);
      expect(gaps[i]).toBeGreaterThan(labels[i - 1] ?? -1);
    });
  });

  test('feeds nothing when the toggle is off', () => {
    const printer = makePrinter();
    printOptionDetails(printer, OPTIONS, 'en', settings);
    expect(gapOffsets(printer.getBuffer())).toHaveLength(0);
  });

  test('the receipt path never feeds the gap', () => {
    const printer = makePrinter();
    printProducts(
      printer,
      {
        details: [
          {
            name: 'Burger',
            net_value: 4.03,
            quantity: 1,
            rec_type: 1,
            tax: { rate: 24, value: 0.97 },
            unit: { code: '1' },
          },
        ],
      },
      {
        products: [
          { content: [{ language: 'en', title: 'Burger' }], options: OPTIONS },
        ],
      },
      { ...settings, optionSpacing: true },
      'en'
    );
    const buf = printer.getBuffer();
    expect(buf.indexOf('CHEESE')).toBeGreaterThan(-1);
    expect(gapOffsets(buf)).toHaveLength(0);
  });
});
