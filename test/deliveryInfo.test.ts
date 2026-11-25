import { describe, expect, test, vi } from 'vitest';
import {
  CharacterSet,
  types as PrinterTypes,
  printer as ThermalPrinter,
} from 'node-thermal-printer';
import { installCharsetGuard } from '../src/modules/charsetGuard';
import { printDeliveryInfo } from '../src/modules/common';

vi.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const render = (deliveryInfo: any, waiterComment?: string) => {
  const characterSet = CharacterSet.PC737_GREEK;
  const printer = installCharsetGuard(
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
  printDeliveryInfo(printer, deliveryInfo, waiterComment, 'en', {
    transliterate: true,
  });
  return printer.getBuffer().toString('latin1');
};

const base = {
  customerAddress: 'Main 1',
  customerFirstname: 'A',
  customerFloor: '2',
  customerLastname: 'B',
  customerPhoneNumber: '123',
};

describe('printDeliveryInfo', () => {
  test('prints the doorbell under the floor', () => {
    const out = render({ ...base, customerDoorbell: 'Smith' });
    expect(out).toContain('DOORBELL:Smith');
    expect(out.indexOf('DOORBELL')).toBeGreaterThan(out.indexOf('FLOOR'));
  });

  test('omits the doorbell line when empty', () => {
    expect(render({ ...base, customerDoorbell: '  ' })).not.toContain(
      'DOORBELL'
    );
    expect(render(base)).not.toContain('DOORBELL');
  });

  test('prints customerBell as comments, not as the doorbell', () => {
    const out = render({ ...base, customerBell: 'ring twice' });
    expect(out).toContain('COMMENTS:ring twice');
    expect(out).not.toContain('DOORBELL');
  });

  test('skips comments already printed as the waiter comment', () => {
    const out = render({ ...base, customerBell: 'Ring Twice' }, 'ring twice');
    expect(out).not.toContain('COMMENTS');
  });
});
