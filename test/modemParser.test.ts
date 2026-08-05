import { feed } from '../src/modules/modemParser';

// Golden master of the parsing that used to live inline in modem.ts.
describe('modemParser.feed', () => {
  it('parses the direct modem CID format', () => {
    const res = feed(
      '',
      'RING\r\nDATE = 0718\r\nTIME = 1730\r\nNMBR = 1234567890\r\nRING\r\n'
    );
    expect(res.phoneNumber).toBe('1234567890');
    expect(res.buffer).toBe('');
  });

  it('parses the CHC format without the equals sign', () => {
    const res = feed('', 'RING\r\nDATE 0408\r\nTIME 1355\r\nNMBR 6976641604\r\n');
    expect(res.phoneNumber).toBe('6976641604');
  });

  it('keeps the leading + of an international number', () => {
    const res = feed('', 'RING\r\nNMBR = +306976641604\r\nRING\r\n');
    expect(res.phoneNumber).toBe('+306976641604');
  });

  it('reassembles a number split across two chunks', () => {
    const first = feed('', 'RING\r\nNM');
    expect(first.phoneNumber).toBeUndefined();

    const second = feed(first.buffer, 'BR = 6976641604\r\n');
    expect(second.phoneNumber).toBe('6976641604');
    expect(second.buffer).toBe('');
  });

  it('holds the buffer while the NMBR line is incomplete', () => {
    const res = feed('', 'RING\r\nNMBR = 6976641604');
    expect(res.phoneNumber).toBeUndefined();
    expect(res.buffer).toBe('RING\r\nNMBR = 6976641604');
  });

  it('handles two successive calls on the same buffer chain', () => {
    const a = feed('', 'RING\r\nNMBR = 1111111111\r\nRING\r\n');
    expect(a.phoneNumber).toBe('1111111111');
    expect(a.buffer).toBe('');

    const b = feed(a.buffer, 'RING\r\nNMBR = 2222222222\r\nRING\r\n');
    expect(b.phoneNumber).toBe('2222222222');
    expect(b.buffer).toBe('');
  });

  it('clears the buffer on overflow instead of growing forever', () => {
    const junk = 'X'.repeat(2000);
    const res = feed('', junk);
    expect(res.buffer).toBe('');
    expect(res.overflowed).toHaveLength(2000);
    expect(res.phoneNumber).toBeUndefined();
  });

  it('ignores noise', () => {
    const res = feed('', 'OK\r\nOK\r\n');
    expect(res.phoneNumber).toBeUndefined();
    expect(res.buffer).toBe('OK\r\nOK\r\n');
  });

  it('keeps two interleaved feed chains fully independent', () => {
    let a = '';
    let b = '';
    let numberA: string | undefined;
    let numberB: string | undefined;

    const chunksA = ['RING\r\nNMBR = 111', '1111111\r\nRING\r\n'];
    const chunksB = ['RING\r\nNMBR = 222', '2222222\r\nRING\r\n'];

    for (let i = 0; i < 2; i++) {
      const ra = feed(a, chunksA[i]!);
      a = ra.buffer;
      numberA = ra.phoneNumber ?? numberA;

      const rb = feed(b, chunksB[i]!);
      b = rb.buffer;
      numberB = rb.phoneNumber ?? numberB;
    }

    expect(numberA).toBe('1111111111');
    expect(numberB).toBe('2222222222');
  });
});
