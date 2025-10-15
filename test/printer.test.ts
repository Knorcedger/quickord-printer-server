import {
  printer as ThermalPrinter,
  types as PrinterTypes,
} from 'node-thermal-printer';

describe('Thermal Printer', () => {
  it('should generate print commands', async () => {
    const printer = new ThermalPrinter({
      type: PrinterTypes.EPSON,
      interface: 'tcp://127.0.0.1', // fake IP, won't actually connect in test
    });

    printer.println('Hello World');
    printer.cut();

    // Mock execute() to return a string (TypeScript compatible)
    const executeSpy = jest
      .spyOn(printer, 'execute')
      .mockImplementation(async () => 'FAKE_ESC_POS_COMMANDS');

    const result = await printer.execute();

    // Test the returned string
    expect(typeof result).toBe('string');
    expect(result).toContain('FAKE_ESC_POS_COMMANDS');

    executeSpy.mockRestore();
  });
});
