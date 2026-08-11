import signale from 'signale';

import { apiCall } from '../src/modules/api';
import { syncModems } from '../src/modules/modem';
import { __resetDedup } from '../src/modules/modemDedup';
import { Settings, updateSettings } from '../src/modules/settings';

import {
  dropAllFakePorts,
  emit,
  instanceFor,
  recordingOf,
  ring,
  useFakePorts,
} from './helpers/fakeModem';

jest.mock('../src/modules/api', () => ({
  apiCall: jest.fn().mockResolvedValue({ data: {} }),
  registerPrinterServerIp: jest.fn(),
}));

const mockedApiCall = apiCall as jest.MockedFunction<typeof apiCall>;

const modem = (port: string, label?: string) => ({ label, port });

// Let queued microtasks/serialport events run without real waiting.
const settle = () => jest.advanceTimersByTimeAsync(1);

const numbersSentToBE = () =>
  mockedApiCall.mock.calls.map(
    (c) => String(c[0]).match(/phoneNumber: "([^"]+)"/)?.[1]
  );

describe('modem registry', () => {
  beforeEach(() => {
    // The mock serial binding resolves its own operations on nextTick.
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.clearAllMocks();
    __resetDedup();
    updateSettings(Settings.parse({ printers: [], venueId: 'venue-1' }));
    useFakePorts('COM3', 'COM4');
  });

  afterEach(async () => {
    await syncModems([]);
    dropAllFakePorts();
    jest.useRealTimers();
  });

  it('M1: opens every configured port', async () => {
    await syncModems([modem('COM3'), modem('COM4')]);

    expect(instanceFor('COM3')?.serial?.isOpen).toBe(true);
    expect(instanceFor('COM4')?.serial?.isOpen).toBe(true);
  });

  it('M2: sends the init string on each port', async () => {
    await syncModems([modem('COM3'), modem('COM4')]);
    await settle();

    expect(recordingOf('COM3')).toContain('AT+GCI=B5\rATS24=0\rAT+VCID=1\r');
    expect(recordingOf('COM4')).toContain('AT+GCI=B5\rATS24=0\rAT+VCID=1\r');
  });

  it('M3: reports a call from one port once', async () => {
    await syncModems([modem('COM3'), modem('COM4')]);

    ring('COM3', '6976641604');
    await settle();

    expect(mockedApiCall).toHaveBeenCalledTimes(1);
    expect(numbersSentToBE()).toEqual(['6976641604']);
    expect(mockedApiCall.mock.calls[0]?.[0]).toContain('venueId:"venue-1"');
  });

  it('M4: reports two simultaneous calls on different ports', async () => {
    await syncModems([modem('COM3'), modem('COM4')]);

    ring('COM3', '2101111111');
    ring('COM4', '2102222222');
    await settle();

    expect(mockedApiCall).toHaveBeenCalledTimes(2);
    expect(numbersSentToBE().sort()).toEqual(['2101111111', '2102222222']);
  });

  it('M5: keeps interleaved chunks of two ports separate', async () => {
    await syncModems([modem('COM3'), modem('COM4')]);

    emit('COM3', 'RING\r\nNMBR = 210111');
    emit('COM4', 'RING\r\nNMBR = 210222');
    emit('COM3', '1111\r\nRING\r\n');
    emit('COM4', '2222\r\nRING\r\n');
    await settle();

    expect(numbersSentToBE().sort()).toEqual(['2101111111', '2102222222']);
  });

  it('M6: suppresses the same call seen by both modems', async () => {
    await syncModems([modem('COM3'), modem('COM4')]);

    ring('COM3', '6976641604');
    ring('COM4', '6976641604');
    await settle();

    expect(mockedApiCall).toHaveBeenCalledTimes(1);
  });

  it('M7: reports the same number again after the dedup window', async () => {
    await syncModems([modem('COM3')]);

    ring('COM3', '6976641604');
    await settle();

    jest.setSystemTime(Date.now() + 6_000);

    ring('COM3', '6976641604');
    await settle();

    expect(mockedApiCall).toHaveBeenCalledTimes(2);
  });

  it('M8: reconnects only the port that dropped', async () => {
    await syncModems([modem('COM3'), modem('COM4')]);

    instanceFor('COM3')!.serial!.close();
    await settle();

    expect(instanceFor('COM3')?.isReconnecting).toBe(true);
    expect(instanceFor('COM4')?.serial?.isOpen).toBe(true);

    // The healthy modem keeps working while the other one is down.
    ring('COM4', '2109999999');
    await settle();
    expect(numbersSentToBE()).toEqual(['2109999999']);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(instanceFor('COM3')?.serial?.isOpen).toBe(true);
  });

  it('M9: gives up on one port without touching the other', async () => {
    const errorSpy = jest.spyOn(signale, 'error').mockImplementation();

    await syncModems([modem('COM3'), modem('COM4')]);

    const com4 = instanceFor('COM4')!;
    // Make reopening COM3 impossible while COM4 stays open.
    dropAllFakePorts();
    instanceFor('COM3')!.serial!.close();

    await jest.advanceTimersByTimeAsync(2_000_000);

    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes('gave up'))
    ).toBe(true);
    expect(instanceFor('COM4')).toBe(com4);
    expect(com4.serial?.isOpen).toBe(true);

    errorSpy.mockRestore();
  });

  it('M10: keepalives every port', async () => {
    await syncModems([modem('COM3'), modem('COM4')]);
    await settle();

    const before3 = recordingOf('COM3').length;
    const before4 = recordingOf('COM4').length;

    await jest.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(recordingOf('COM3').slice(before3)).toBe('AT\r');
    expect(recordingOf('COM4').slice(before4)).toBe('AT\r');
  });

  it('M11: removing a modem does not disturb the remaining one', async () => {
    await syncModems([modem('COM3'), modem('COM4')]);

    const com3 = instanceFor('COM3')!;
    const serial3 = com3.serial;
    const com4 = instanceFor('COM4')!;

    await syncModems([modem('COM3')]);

    expect(instanceFor('COM4')).toBeUndefined();
    expect(com4.serial).toBeNull();
    expect(instanceFor('COM3')).toBe(com3);
    expect(com3.serial).toBe(serial3);
    expect(com3.serial?.isOpen).toBe(true);
  });

  it('M12: adding a modem keeps the existing connection', async () => {
    await syncModems([modem('COM3')]);
    const serial3 = instanceFor('COM3')!.serial;

    await syncModems([modem('COM3'), modem('COM4')]);

    expect(instanceFor('COM3')!.serial).toBe(serial3);
    expect(instanceFor('COM4')?.serial?.isOpen).toBe(true);
  });

  it('M13: a port that cannot open does not take down the others', async () => {
    const errorSpy = jest.spyOn(signale, 'error').mockImplementation();

    await syncModems([modem('COM3'), modem('COM9')]);

    expect(instanceFor('COM3')?.serial?.isOpen).toBe(true);
    expect(instanceFor('COM9')?.serial).toBeNull();
    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes('COM9'))
    ).toBe(true);

    errorSpy.mockRestore();
  });

  it('M14: opens a duplicated port only once', async () => {
    const warnSpy = jest.spyOn(signale, 'warn').mockImplementation();

    await syncModems([modem('COM3'), modem('COM3')]);

    expect(instanceFor('COM3')?.serial?.isOpen).toBe(true);
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes('Duplicate modem'))
    ).toBe(true);

    warnSpy.mockRestore();
  });
});
