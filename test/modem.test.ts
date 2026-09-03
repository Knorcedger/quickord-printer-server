import signale from 'signale';

import { apiCall } from '../src/modules/api';
import {
  __setInitDelayMs,
  __setInitTimings,
  matchInitReply,
  syncModems,
} from '../src/modules/modem';
import { __resetDedup } from '../src/modules/modemDedup';
import { Settings, updateSettings } from '../src/modules/settings';

import {
  dropAllFakePorts,
  emit,
  instanceFor,
  recordingOf,
  ring,
  settleInit,
  useFakePorts,
} from './helpers/fakeModem';

jest.mock('../src/modules/api', () => ({
  apiCall: jest.fn().mockResolvedValue({ data: {} }),
  registerPrinterServerIp: jest.fn(),
  startPrinterServerIpRegistration: jest.fn(),
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

  it('M2: sends the init commands on each port', async () => {
    await syncModems([modem('COM3'), modem('COM4')]);
    await settleInit();

    ['COM3', 'COM4'].forEach((port) => {
      expect(recordingOf(port)).toBe(
        'ATE1\rAT\rAT+GCI=B5\rATS24=0\rAT+VCID=1\r'
      );
    });
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

    const com3 = instanceFor('COM3')!;
    const com4 = instanceFor('COM4')!;
    // Make reopening COM3 impossible while COM4 stays open.
    dropAllFakePorts();
    com3.serial!.close();

    await jest.advanceTimersByTimeAsync(2_000_000);

    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes('gave up'))
    ).toBe(true);
    // Giving up fully tears down the dead instance's timers.
    expect(com3.keepalive).toBe(null);
    expect(instanceFor('COM4')).toBe(com4);
    expect(com4.serial?.isOpen).toBe(true);

    errorSpy.mockRestore();
  });

  it('M10: keepalives every port', async () => {
    await syncModems([modem('COM3'), modem('COM4')]);
    await settleInit();

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
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('COM9'))).toBe(
      true
    );

    errorSpy.mockRestore();
  });

  it('M15: a sync arriving while another sync is opening does not leak a half-open port', async () => {
    const errorSpy = jest.spyOn(signale, 'error').mockImplementation();

    // Reopen the race window that useFakePorts closes with a 0ms init delay.
    __setInitDelayMs(20);

    const first = syncModems([modem('COM3')]);
    await settle();
    const early = instanceFor('COM3');

    const second = syncModems([modem('COM3')]);
    await jest.advanceTimersByTimeAsync(2_000);
    await Promise.all([first, second]);

    const final = instanceFor('COM3')!;
    expect(final.serial?.isOpen).toBe(true);

    // A superseded instance must not have adopted the port it was opening.
    if (early && early !== final) {
      expect(early.serial).toBeNull();
      expect(early.keepalive).toBeNull();
    }

    errorSpy.mockRestore();
  });

  it('M16: re-issues VCID when a RING arrives without a CID block', async () => {
    const warnSpy = jest.spyOn(signale, 'warn').mockImplementation();
    await syncModems([modem('COM3')]);
    await settleInit();
    const before = recordingOf('COM3').length;

    emit('COM3', 'RING\r\n');
    await jest.advanceTimersByTimeAsync(5_000);

    expect(recordingOf('COM3').slice(before)).toBe('AT+VCID=1\r');
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes('without NMBR'))
    ).toBe(true);

    warnSpy.mockRestore();
  });

  it('M17: a RING that carries its CID block does not re-issue VCID', async () => {
    await syncModems([modem('COM3')]);
    await settleInit();
    const before = recordingOf('COM3').length;

    ring('COM3', '6976641604');
    await jest.advanceTimersByTimeAsync(5_000);
    // Later RINGs of the same call carry no NMBR and must stay quiet too.
    emit('COM3', 'RING\r\n');
    await jest.advanceTimersByTimeAsync(5_000);

    expect(recordingOf('COM3').slice(before)).toBe('');
    expect(instanceFor('COM3')?.consecutiveVcidReissues).toBe(0);
  });

  it('M18: reconnects the port after three re-issues in a row', async () => {
    const errorSpy = jest.spyOn(signale, 'error').mockImplementation();
    jest.spyOn(signale, 'warn').mockImplementation();

    await syncModems([modem('COM3')]);
    await settleInit();
    const inst = instanceFor('COM3')!;
    const firstSerial = inst.serial;

    for (let i = 0; i < 3; i++) {
      emit('COM3', 'RING\r\n');
      // eslint-disable-next-line no-await-in-loop
      await jest.advanceTimersByTimeAsync(35_000); // past RECENT_NMBR_WINDOW_MS
    }

    expect(
      errorSpy.mock.calls.some((c) =>
        String(c[0]).includes('forcing reconnect')
      )
    ).toBe(true);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(inst.serial).not.toBe(firstSerial);
    expect(inst.serial?.isOpen).toBe(true);

    jest.restoreAllMocks();
  });

  it('M19: an old re-issue does not count towards the streak', async () => {
    jest.spyOn(signale, 'warn').mockImplementation();
    const errorSpy = jest.spyOn(signale, 'error').mockImplementation();

    await syncModems([modem('COM3')]);
    await settleInit();

    for (let i = 0; i < 4; i++) {
      emit('COM3', 'RING\r\n');
      // eslint-disable-next-line no-await-in-loop
      await jest.advanceTimersByTimeAsync(11 * 60_000); // past the decay window
    }

    expect(
      errorSpy.mock.calls.some((c) =>
        String(c[0]).includes('forcing reconnect')
      )
    ).toBe(false);
    expect(instanceFor('COM3')?.consecutiveVcidReissues).toBe(1);

    jest.restoreAllMocks();
  });

  it('M20: init does not block the caller of syncModems', async () => {
    // Production timings: a modem that never answers burns the whole budget.
    __setInitTimings({
      attempts: 2,
      backoffMs: 500,
      drainMs: 1500,
      settleMs: 200,
      timeoutMs: 3000,
    });

    await syncModems([modem('COM3')]);

    // The port is usable the moment it opens; init is still in its drain phase.
    expect(instanceFor('COM3')?.serial?.isOpen).toBe(true);
    expect(recordingOf('COM3')).toBe('');

    await jest.advanceTimersByTimeAsync(60_000);
    await instanceFor('COM3')?.initPromise;
    expect(recordingOf('COM3')).toContain('AT+VCID=1\r');
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

describe('matchInitReply', () => {
  it('waits for the echo before accepting an OK', () => {
    expect(matchInitReply('OK\r\n', 'AT+VCID=1', true)).toBe(null);
    expect(matchInitReply('AT+VCID=1\r\r\nOK\r\n', 'AT+VCID=1', true)).toBe(
      'ok'
    );
  });

  it('ignores an OK that arrived before the echo', () => {
    // Leftover boot-time output must not answer for the command.
    expect(matchInitReply('OK\r\nAT\r', 'AT', true)).toBe(null);
  });

  it('does not let the echo of a longer command match a shorter one', () => {
    expect(matchInitReply('AT+GCI=B5\r\r\nOK\r\n', 'AT', true)).toBe(null);
  });

  it('reports an ERROR reply', () => {
    expect(matchInitReply('ATS24=0\r\r\nERROR\r\n', 'ATS24=0', true)).toBe(
      'error'
    );
  });

  it('matches without the echo anchor when echo is off', () => {
    expect(matchInitReply('\r\nOK\r\n', 'AT+VCID=1', false)).toBe('ok');
    expect(matchInitReply('\r\nERROR\r\n', 'AT+GCI=B5', false)).toBe('error');
    expect(matchInitReply('\r\n', 'AT', false)).toBe(null);
  });
});
