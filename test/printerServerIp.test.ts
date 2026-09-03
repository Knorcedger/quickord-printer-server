import os from 'os';

jest.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.mock('../src/modules/http', () => ({
  __esModule: true,
  curlExecJson: jest.fn(),
  httpStatusError: jest.fn(),
  tryFetchWithFallback: jest.fn(),
  withTempJsonPayload: jest.fn(),
}));

type Api = typeof import('../src/modules/api');
type Http = typeof import('../src/modules/http');
type Logger = typeof import('../src/modules/logger').default;

// Fresh module registry per test: the retry loop keeps its venueId in module
// state, and a leaked loop from an earlier test would keep firing.
const load = () => {
  let api!: Api;
  let http!: Http;
  let logger!: Logger;
  jest.isolateModules(() => {
    api = require('../src/modules/api');
    http = require('../src/modules/http');
    logger = require('../src/modules/logger').default;
  });
  return {
    api,
    logger: logger as jest.Mocked<Logger>,
    tryFetch: http.tryFetchWithFallback as jest.MockedFunction<
      typeof http.tryFetchWithFallback
    >,
  };
};

const ifaces = (entries: Record<string, [string, boolean?][]>) =>
  jest.spyOn(os, 'networkInterfaces').mockReturnValue(
    Object.fromEntries(
      Object.entries(entries).map(([name, addrs]) => [
        name,
        addrs.map(([address, internal]) => ({
          address,
          cidr: null,
          family: 'IPv4' as const,
          internal: !!internal,
          mac: '00:00:00:00:00:00',
          netmask: '255.255.255.0',
        })),
      ])
    ) as ReturnType<typeof os.networkInterfaces>
  );

const okResponse = {
  data: {
    data: { updatePrinterServerIp: { ip: '192.168.1.50', status: 'ok' } },
  },
  fetchAttempts: 1,
  viaFallback: false,
};

describe('getLocalIP', () => {
  afterEach(() => jest.restoreAllMocks());

  it('prefers a physical adapter over a virtual one', () => {
    ifaces({
      'vEthernet (WSL)': [['172.28.0.1']],
      Ethernet: [['192.168.1.50']],
    });
    expect(load().api.getLocalIP()).toBe('192.168.1.50');
  });

  it('never returns loopback when nothing is up', () => {
    ifaces({ 'Loopback Pseudo-Interface 1': [['127.0.0.1', true]] });
    expect(load().api.getLocalIP()).toBeNull();
    expect(load().api.getLocalIP({ allowVirtual: true })).toBeNull();
  });

  it('withholds a virtual-only address unless the caller opts in', () => {
    ifaces({ 'vEthernet (Default Switch)': [['172.28.0.1']] });
    const { api } = load();
    expect(api.getLocalIP()).toBeNull();
    expect(api.getLocalIP({ allowVirtual: true })).toBe('172.28.0.1');
  });
});

describe('startPrinterServerIpRegistration', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.setSystemTime(new Date('2026-09-03T10:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('waits for a lease instead of publishing a virtual address at boot', async () => {
    ifaces({ 'vEthernet (Default Switch)': [['172.28.0.1']] });
    const { api, logger, tryFetch } = load();
    tryFetch.mockResolvedValue(okResponse as any);

    api.startPrinterServerIpRegistration('venue-1');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(tryFetch).not.toHaveBeenCalled();
    // One deferral warning, not one per attempt.
    expect(logger.warn).toHaveBeenCalledTimes(1);

    ifaces({
      'vEthernet (Default Switch)': [['172.28.0.1']],
      Ethernet: [['192.168.1.50']],
    });
    await jest.advanceTimersByTimeAsync(15_000);
    expect(tryFetch).toHaveBeenCalledTimes(1);
  });

  it('accepts a virtual-only address once the DHCP window has passed', async () => {
    ifaces({ 'vEthernet (External)': [['192.168.1.60']] });
    const { api, logger, tryFetch } = load();
    tryFetch.mockResolvedValue(okResponse as any);

    api.startPrinterServerIpRegistration('venue-2');
    await jest.advanceTimersByTimeAsync(5 * 60_000 + 15_000);

    expect(tryFetch).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'Registering printer server IP: 192.168.1.60 for venue: venue-2'
    );
  });

  it('retries until the backend confirms, then stops', async () => {
    ifaces({ Ethernet: [['192.168.1.50']] });
    const { api, logger, tryFetch } = load();
    tryFetch
      .mockRejectedValueOnce(new Error('fetch and curl both failed'))
      .mockResolvedValueOnce({
        ...okResponse,
        data: { data: { updatePrinterServerIp: { status: 'pending' } } },
      } as any)
      .mockResolvedValue(okResponse as any);

    api.startPrinterServerIpRegistration('venue-3');
    await jest.advanceTimersByTimeAsync(45_000);

    expect(tryFetch).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      'Printer server IP registered successfully'
    );

    // Confirmed once: no further attempts for the life of the process.
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(tryFetch).toHaveBeenCalledTimes(3);
  });

  it('collapses the logs of a sustained outage and backs off', async () => {
    ifaces({ Ethernet: [['192.168.1.50']] });
    const { api, logger, tryFetch } = load();
    tryFetch.mockRejectedValue(new Error('fetch and curl both failed'));

    api.startPrinterServerIpRegistration('venue-4');
    await jest.advanceTimersByTimeAsync(60 * 60_000);

    // 4 attempts at 15s, then one a minute — not 240.
    expect(tryFetch.mock.calls.length).toBeLessThan(70);
    // Only the first attempt lets the http layer dump the failure.
    expect(
      tryFetch.mock.calls.filter(
        (call) => !(call[0] as any).suppressFailureLogs
      )
    ).toHaveLength(1);
    // One full line, then one summary per 5 minutes.
    expect(logger.error.mock.calls.length).toBeLessThanOrEqual(13);
    expect(logger.error).toHaveBeenNthCalledWith(
      1,
      'Printer server IP registration failed:',
      expect.any(Error)
    );
    expect(logger.error.mock.calls[1]?.[0]).toMatch(
      /^Printer server IP registration still failing — \d+ consecutive failures over \d+m/
    );
  });
});
