// The lib switches code page on its own when a character is missing from the
// configured one; on CP737 printers the first `€` broke every Greek label after
// it. These lock the guard at the byte level.
import iconv from 'iconv-lite';
import {
  CharacterSet,
  printer as ThermalPrinter,
  types as PrinterTypes,
} from 'node-thermal-printer';
import {
  installCharsetGuard,
  sanitizeForEncoding,
  sanitizeForPrinter,
} from '../src/modules/charsetGuard';

const SAMPLE = 'ΣΥΝΟΛΟ: 5.00 €';
const CODE_PAGE = 7;

const noopInterface = {
  execute: async (buffer: Buffer) => buffer,
  isPrinterConnected: async () => true,
} as any;

const makePrinter = (characterSet: CharacterSet) =>
  new ThermalPrinter({
    characterSet,
    interface: noopInterface,
    type: PrinterTypes.EPSON,
  });

// Every `ESC t n` in the buffer, in order.
const escTPages = (buf: Buffer): number[] => {
  const pages: number[] = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0x1b && buf[i + 1] === 0x74) pages.push(buf[i + 2] ?? -1);
  }
  return pages;
};

const render = (characterSet: CharacterSet, text: string): Buffer => {
  const printer = installCharsetGuard(makePrinter(characterSet), characterSet);
  printer.add(Buffer.from([0x1b, 0x74, CODE_PAGE]));
  printer.println(text);
  return printer.getBuffer();
};

describe('charset guard', () => {
  test('PC737 stays on its page and prints EUR for the euro sign', () => {
    const buf = render(CharacterSet.PC737_GREEK, SAMPLE);

    // Constructor page (PC737 = 14) plus the explicit one; no ISO-8859-7 (15).
    expect(escTPages(buf)).toEqual([14, CODE_PAGE]);
    expect(buf.includes(iconv.encode('ΣΥΝΟΛΟ', 'CP737'))).toBe(true);
    expect(buf.includes(Buffer.from('5.00 EUR'))).toBe(true);
    expect(buf.includes(0xa4)).toBe(false);
  });

  test('WPC1253 output is byte-identical to an unguarded printer', () => {
    const unguarded = makePrinter(CharacterSet.WPC1253_GREEK);
    unguarded.add(Buffer.from([0x1b, 0x74, CODE_PAGE]));
    unguarded.println(SAMPLE);

    const guarded = render(CharacterSet.WPC1253_GREEK, SAMPLE);
    expect(guarded.equals(unguarded.getBuffer())).toBe(true);
    expect(guarded.includes(0x80)).toBe(true);
    expect(guarded.includes(Buffer.from('EUR'))).toBe(false);
  });

  test('leftRight and table go through the guard too', () => {
    const printer = installCharsetGuard(
      makePrinter(CharacterSet.PC737_GREEK),
      CharacterSet.PC737_GREEK
    );
    printer.leftRight('ΤΕΜΑΧΙΑ: 2', '5.00 €');
    printer.table(['ΦΠΑ', '1.00 €']);
    const buf = printer.getBuffer();

    expect(escTPages(buf)).toEqual([14]);
    expect(buf.includes(Buffer.from('EUR'))).toBe(true);
  });

  test('symbols fall back to ASCII, diacritics are stripped, the rest is ?', () => {
    expect(sanitizeForEncoding('→ — … ×', 'CP737')).toBe('-> - ... x');
    expect(sanitizeForEncoding('Ǎ', 'CP737')).toBe('A');
    expect(sanitizeForEncoding('Ｘ', 'CP737')).toBe('?');
    expect(sanitizeForEncoding('ΣΥΝΟΛΟ άέ', 'CP737')).toBe('ΣΥΝΟΛΟ άέ');
    expect(sanitizeForEncoding('plain ascii', 'CP737')).toBe('plain ascii');
  });

  test('sanitizeForPrinter sanitizes only guarded printers', () => {
    const guarded = installCharsetGuard(
      makePrinter(CharacterSet.PC737_GREEK),
      CharacterSet.PC737_GREEK
    );
    expect(sanitizeForPrinter(guarded, SAMPLE)).toBe('ΣΥΝΟΛΟ: 5.00 EUR');
    expect(sanitizeForPrinter({} as any, SAMPLE)).toBe(SAMPLE);
  });
});
