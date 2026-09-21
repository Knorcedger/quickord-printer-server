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
import {
  buildProductRow,
  printDeliveryNoteProducts,
  printOptionDetails,
  printProducts,
} from '../src/modules/common';

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

  test('decomposed input drops the lone combining mark instead of printing ?', () => {
    // NFD 'ά' = 'α' + U+0301; the mark alone is not in CP737.
    expect(sanitizeForEncoding('ά'.normalize('NFD'), 'CP737')).toBe('α');
    expect(sanitizeForEncoding('́', 'CP737')).toBe('');
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

  // An option label wider than the row used to escape wrapping: wrapChoices
  // emitted the whole prefix as its first line, so an expanded `…` or `€` in
  // the label ran past the paper.
  describe('option labels wider than the row are wrapped', () => {
    const settings: any = { priceOnOrder: true, transliterate: false };

    const renderLabel = (
      characterSet: CharacterSet,
      title: string,
      choices: any[],
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
      printOptionDetails(
        printer,
        [{ choices, content: [{ language: 'el', title }] }] as any,
        'el',
        settings,
        enlarged
      );
      return lines;
    };

    // ' - ' + 'ΔΙΑΛΕΞΤΕ ΣΥΝΟΔΕΥΤΙΚΟ...' + ': ' = 28 cells on a 21-cell row.
    const LONG_LABEL = 'ΔΙΑΛΕΞΤΕ ΣΥΝΟΔΕΥΤΙΚΟ…';

    test('BOLD_PRODUCTS: the expanded label wraps to the 21-cell row', () => {
      const lines = renderLabel(
        CharacterSet.PC737_GREEK,
        LONG_LABEL,
        [{ content: [{ language: 'el', title: 'ΠΑΤΑΤΕΣ' }], price: 250 }],
        true
      );
      expect(lines.join(' ')).toContain('ΣΥΝΟΔΕΥΤΙΚΟ...');
      expect(lines.length).toBeGreaterThan(1);
      lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(21));
    });

    test('BOLD_PRODUCTS: it wraps with no choices at all', () => {
      const lines = renderLabel(CharacterSet.PC869_GREEK, LONG_LABEL, [], true);
      expect(lines.join(' ')).toContain('ΣΥΝΟΔΕΥΤΙΚΟ...');
      lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(21));
    });

    test('normal size: a label past 42 cells wraps too', () => {
      const lines = renderLabel(
        CharacterSet.PC737_GREEK,
        'ΔΙΑΛΕΞΤΕ ΣΥΝΟΔΕΥΤΙΚΟ ΚΑΙ ΣΑΛΤΣΑ ΓΙΑ ΤΟ ΜΕΝΟΥ…',
        [{ content: [{ language: 'el', title: 'ΠΑΤΑΤΕΣ' }], price: 250 }],
        false
      );
      lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(42));
    });

    test('a wrapped label keeps its internal double spaces', () => {
      const lines = renderLabel(
        CharacterSet.PC737_GREEK,
        'ΔΙΑΛΕΞΤΕ  ΣΥΝΟΔΕΥΤΙΚΟ ΚΑΙ ΣΑΛΤΣΑ ΓΙΑ ΤΟ ΜΕΝΟΥ…',
        [],
        false
      );
      expect(lines[0]).toContain('ΔΙΑΛΕΞΤΕ  ΣΥΝΟΔΕΥΤΙΚΟ');
      lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(42));
    });

    test('a label that fits is left exactly as it was', () => {
      const lines = renderLabel(
        CharacterSet.PC737_GREEK,
        'ΕΞΤΡΑ',
        [{ content: [{ language: 'el', title: 'ΠΑΤΑΤΕΣ' }], price: 250 }],
        false
      );
      expect(lines[0]!.startsWith('     - ΕΞΤΡΑ: ΠΑΤΑΤΕΣ')).toBe(true);
    });
  });

  // Receipt and delivery-note rows are fixed columns: the name is measured,
  // chunked and padded, so it has to be sanitized before any of that.
  describe('invoice item names keep their columns', () => {
    const settings: any = { transliterate: false };

    const detail = (name: string) => ({
      name,
      net_value: 4.03,
      quantity: 1,
      rec_type: 1,
      tax: { rate: 24, value: 0.97 },
      unit: { code: '1' },
    });

    const capture = (characterSet: CharacterSet) => {
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
      return { lines, printer };
    };

    // Same visible length as the expanding name, so the rows must match.
    const EXPANDING = 'ΚΑΦΕΣ… ΦΙΛΤΡΟΥ 2€';
    const PLAIN = 'ΚΑΦΕΣ ΦΙΛΤΡΟΥ ΜΕΓΑΛ';

    test('PC737 receipt rows keep the value and VAT columns in place', () => {
      const expanding = capture(CharacterSet.PC737_GREEK);
      printProducts(
        expanding.printer,
        { details: [detail(EXPANDING)] },
        {},
        settings,
        'el'
      );
      const plain = capture(CharacterSet.PC737_GREEK);
      printProducts(
        plain.printer,
        { details: [detail(PLAIN)] },
        {},
        settings,
        'el'
      );

      const row = (lines: string[]) => lines.find((l) => l.startsWith('1  '))!;
      expect(row(expanding.lines)).toContain('ΚΑΦΕΣ...');
      expect(row(expanding.lines).length).toBe(row(plain.lines).length);
      expect(row(expanding.lines).endsWith('       24%')).toBe(true);
      expanding.lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(48));
    });

    test('PC869 delivery-note rows keep their column widths', () => {
      const expanding = capture(CharacterSet.PC869_GREEK);
      printDeliveryNoteProducts(
        expanding.printer,
        { details: [detail(EXPANDING)] } as any,
        'el',
        false
      );
      const plain = capture(CharacterSet.PC869_GREEK);
      printDeliveryNoteProducts(
        plain.printer,
        { details: [detail(PLAIN)] } as any,
        'el',
        false
      );

      const row = (lines: string[]) => lines.find((l) => l.includes('ΤΕΜ'))!;
      expect(row(expanding.lines).startsWith('ΚΑΦΕΣ...')).toBe(true);
      expect(row(expanding.lines).length).toBe(row(plain.lines).length);
    });
  });
});
