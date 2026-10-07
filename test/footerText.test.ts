import { printFooterText } from '../src/modules/common';

jest.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

const makePrinter = () => {
  const lines: string[] = [];
  return {
    alignCenter: jest.fn(),
    lines,
    newLine: () => lines.push(''),
    println: (text: string) => lines.push(text),
  };
};

const render = (settings: {
  receiptFooterText?: string;
  transliterate?: boolean;
}) => {
  const printer = makePrinter();
  printFooterText(printer as any, settings);
  return printer;
};

describe('printFooterText', () => {
  test('prints nothing when the footer is missing or blank', () => {
    expect(render({}).lines).toEqual([]);
    expect(render({ receiptFooterText: ' \r\n ' }).lines).toEqual([]);
  });

  test('prints each typed line centered after a blank line', () => {
    const printer = render({
      receiptFooterText: 'Ευχαριστούμε για την προτίμηση!\r\nΚαλή συνέχεια',
    });

    expect(printer.alignCenter).toHaveBeenCalled();
    expect(printer.lines).toEqual([
      '',
      'Ευχαριστούμε για την προτίμηση!',
      'Καλή συνέχεια',
    ]);
  });

  test('wraps a long footer to the 42-column line', () => {
    const text = `${'word '.repeat(20)}end`;
    const lines = render({ receiptFooterText: text }).lines.slice(1);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.length <= 42)).toBe(true);
    expect(lines.map((l) => l.trim()).join(' ')).toBe(text);
  });

  test('transliterates when the printer asks for it', () => {
    expect(
      render({ receiptFooterText: 'Ευχαριστούμε', transliterate: true }).lines
    ).toEqual(['', 'Eyharistoyme']);
  });
});
