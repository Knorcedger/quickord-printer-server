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
import { buildProductRow, printOptionDetails } from '../src/modules/common';

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

  // The guard widens `€` to `EUR`; a row padded from the raw price length
  // would overflow the paper by two cells on PC737/PC869.
  describe('padded option rows stay on the paper on PC737', () => {
    const option = (title: string) =>
      [
        {
          choices: [{ content: [{ language: 'el', title }], price: 250 }],
          content: [{ language: 'el', title: 'ΕΞΤΡΑ' }],
        },
      ] as any;
    const settings: any = { priceOnOrder: true, transliterate: false };

    const renderOptions = (enlarged: boolean) => {
      const printer = installCharsetGuard(
        makePrinter(CharacterSet.PC737_GREEK),
        CharacterSet.PC737_GREEK
      );
      const lines: string[] = [];
      const println = printer.println.bind(printer);
      (printer as any).println = (text: string) => {
        lines.push(sanitizeForPrinter(printer, text));
        return println(text);
      };
      printOptionDetails(
        printer,
        option('ΔΙΠΛΟ ΜΠΙΦΤΕΚΙ ΜΟΣΧΑΡΙΣΙΟ'),
        'el',
        settings,
        enlarged
      );
      return lines;
    };

    test('normal size: the price row is exactly 42 characters', () => {
      const lines = renderOptions(false);
      const last = lines[lines.length - 1]!;
      expect(last.endsWith('2.50 EUR')).toBe(true);
      expect(last.length).toBe(42);
      lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(42));
    });

    test('BOLD_PRODUCTS: every row fits the 21-character enlarged line', () => {
      const lines = renderOptions(true);
      expect(lines.some((l) => l.endsWith('2.50 EUR'))).toBe(true);
      lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(21));
    });
  });

  // Menu text carries the same expanding characters as the price does. Before
  // the option label and the choice values were sanitized up front, a `€` or
  // `…` in a title grew after the row had already been wrapped and padded.
  describe('expanding characters in option text', () => {
    const settings: any = { priceOnOrder: true, transliterate: false };
    const charsets = [
      [CharacterSet.PC737_GREEK, 'PC737'],
      [CharacterSet.PC869_GREEK, 'PC869'],
    ] as const;

    const renderOptions = (
      characterSet: CharacterSet,
      options: any,
      enlarged: boolean
    ) => {
      const printer = installCharsetGuard(
        makePrinter(characterSet),
        characterSet
      );
      const lines: string[] = [];
      const println = printer.println.bind(printer);
      (printer as any).println = (text: string) => {
        lines.push(sanitizeForPrinter(printer, text));
        return println(text);
      };
      printOptionDetails(printer, options, 'el', settings, enlarged);
      return lines;
    };

    // `…` → `...` and `€` → `EUR` each add two characters after wrapping.
    const options = [
      {
        choices: [
          {
            content: [{ language: 'el', title: 'ΜΕ ΣΑΛΤΣΑ… ΚΑΙ ΤΥΡΙ 1€' }],
            price: 250,
          },
        ],
        content: [{ language: 'el', title: 'ΕΞΤΡΑ… 2€' }],
      },
    ] as any;

    charsets.forEach(([characterSet, label]) => {
      test(`${label}: rows stay within 42 characters`, () => {
        const lines = renderOptions(characterSet, options, false);
        expect(lines.some((l) => l.includes('EUR'))).toBe(true);
        expect(lines.some((l) => l.includes('...'))).toBe(true);
        lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(42));
      });

      test(`${label}: BOLD_PRODUCTS rows stay within 21 characters`, () => {
        const lines = renderOptions(characterSet, options, true);
        lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(21));
      });
    });
  });

  // The product row measures the title, pads it, then appends the price, so an
  // expanding character in the title used to push the price column off the row.
  describe('expanding characters in a product title', () => {
    const productRow = (
      title: string,
      { boldPrices = false, boldProducts = false } = {}
    ) => {
      const characterSet = CharacterSet.PC737_GREEK;
      const printer = installCharsetGuard(
        makePrinter(characterSet),
        characterSet
      );
      const priceStr = sanitizeForPrinter(printer, ' 5.00 €');
      const { enlargePrice, leadingLines, paddedLine } = buildProductRow(
        printer,
        `1x ${title}`,
        priceStr,
        { boldPrices, boldProducts }
      );
      return {
        cells: paddedLine.length + priceStr.length * (enlargePrice ? 2 : 1),
        rows: [...leadingLines, paddedLine + priceStr],
      };
    };

    test('normal size: a title with `€` still ends on cell 42', () => {
      const { cells, rows } = productRow('ΜΕΝΟΥ 5€');
      expect(rows[rows.length - 1]).toContain('ΜΕΝΟΥ 5EUR');
      expect(cells).toBe(42);
      expect(rows[rows.length - 1]!.length).toBe(42);
    });

    test('normal size: a title with `…` and `→` still ends on cell 42', () => {
      const { cells, rows } = productRow('ΚΡΕΠΑ… ΓΛΥΚΙΑ → ΜΕΓΑΛΗ');
      const last = rows[rows.length - 1]!;
      expect(last).toContain('...');
      expect(last).toContain('->');
      expect(cells).toBe(42);
      rows.forEach((r) => expect(r.length).toBeLessThanOrEqual(42));
    });

    test('BOLD_PRODUCTS: the row stays inside the 21 enlarged cells', () => {
      const { rows } = productRow('ΜΕΝΟΥ 5€', { boldProducts: true });
      rows.forEach((r) => expect(r.length).toBeLessThanOrEqual(21));
    });

    test('BOLD_PRICES: the enlarged price still has its reserved cells', () => {
      const { cells, rows } = productRow('ΜΕΝΟΥ 5€', { boldPrices: true });
      // 24 title cells + the 9-character price at double width = 42.
      expect(cells).toBe(42);
      expect(rows[rows.length - 1]).toContain('5.00 EUR');
    });
  });
});
