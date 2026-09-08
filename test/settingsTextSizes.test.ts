// The printer server only stores the per-element sizes; its LAN-fallback
// renderer still goes by textOptions. What matters here is that settings.json
// round-trips the new field and that a bad level is rejected rather than stored.
import { PrinterSettings } from '../src/modules/settings';

const basePrinter = {
  characterSet: 'WPC1253_GREEK',
  ip: '192.168.1.50',
  name: 'KITCHEN',
  networkName: 'kitchen',
};

describe('PrinterSettings.textSizes', () => {
  test('round-trips the levels the backend sends', () => {
    const parsed = PrinterSettings.parse({
      ...basePrinter,
      textOptions: ['BOLD_PRODUCTS'],
      textSizes: { prices: 2, products: 1 },
    });

    expect(parsed.textSizes).toEqual({ prices: 2, products: 1 });
    // The legacy flag has to survive alongside it — that is what still bolds on
    // the LAN fallback.
    expect(parsed.textOptions).toEqual(['BOLD_PRODUCTS']);
  });

  test('is optional, so an older backend payload still parses', () => {
    const parsed = PrinterSettings.parse({
      ...basePrinter,
      textOptions: [],
    });

    expect(parsed.textSizes).toBeUndefined();
  });

  test('keeps an explicit 0 rather than dropping it', () => {
    const parsed = PrinterSettings.parse({
      ...basePrinter,
      textSizes: { products: 0 },
    });

    expect(parsed.textSizes?.products).toBe(0);
  });

  test('rejects a level outside the ladder', () => {
    expect(() =>
      PrinterSettings.parse({ ...basePrinter, textSizes: { products: 3 } })
    ).toThrow();
    expect(() =>
      PrinterSettings.parse({ ...basePrinter, textSizes: { products: -1 } })
    ).toThrow();
    expect(() =>
      PrinterSettings.parse({ ...basePrinter, textSizes: { products: 1.5 } })
    ).toThrow();
  });

  test('strips an element it does not know', () => {
    const parsed = PrinterSettings.parse({
      ...basePrinter,
      textSizes: { footer: 2, products: 1 },
    });

    expect(parsed.textSizes).toEqual({ products: 1 });
  });
});
