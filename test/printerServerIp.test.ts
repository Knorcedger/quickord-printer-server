import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mocked,
  type MockedFunction,
  vi,
} from 'vitest';
import os from 'os';

vi.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../src/modules/http', () => ({
  __esModule: true,
  curlExecJson: vi.fn(),
  httpStatusError: vi.fn(),
  tryFetchWithFallback: vi.fn(),
  withTempJsonPayload: vi.fn(),
}));

type Api = typeof import('../src/modules/api');
type Http = typeof import('../src/modules/http');
type Logger = typeof import('../src/modules/logger').default;

// Fresh module registry per test: the retry loop keeps its venueId in module
// state, and a leaked loop from an earlier test would keep firing.
const load = async () => {
  vi.resetModules();
  const api: Api = await import('../src/modules/api');
  const http: Http = await import('../src/modules/http');
  const logger: Logger = (await import('../src/modules/logger')).default;
  return {
    api,
    logger: logger as Mocked<Logger>,
    tryFetch: http.tryFetchWithFallback as MockedFunction<
      typeof http.tryFetchWithFallback
    >,
  };
};

const ifaces = (entries: Record<string, [string, boolean?][]>) =>
  vi.spyOn(os, 'networkInterfaces').mockReturnValue(
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

describe('getLocalIP', async () => {
  afterEach(() => vi.restoreAllMocks());

  it('prefers a physical adapter over a virtual one', async () => {
    ifaces({
      'vEthernet (WSL)': [['172.28.0.1']],
      Ethernet: [['192.168.1.50']],
    });
    expect((await load()).api.getLocalIP()).toBe('192.168.1.50');
  });

  it('never returns loopback when nothing is up', async () => {
    ifaces({ 'Loopback Pseudo-Interface 1': [['127.0.0.1', true]] });
    expect((await load()).api.getLocalIP()).toBeNull();
    expect((await load()).api.getLocalIP({ allowVirtual: true })).toBeNull();
  });

  it('withholds a virtual-only address unless the caller opts in', async () => {
    ifaces({ 'vEthernet (Default Switch)': [['172.28.0.1']] });
    const { api } = await load();
    expect(api.getLocalIP()).toBeNull();
    expect(api.getLocalIP({ allowVirtual: true })).toBe('172.28.0.1');
  });
});

describe('startPrinterServerIpRegistration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toNotFake: ['nextTick'] });
    vi.setSystemTime(new Date('2026-09-03T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits for a lease instead of publishing a virtual address at boot', async () => {
    ifaces({ 'vEthernet (Default Switch)': [['172.28.0.1']] });
    const { api, logger, tryFetch } = await load();
    tryFetch.mockResolvedValue(okResponse as any);

    api.startPrinterServerIpRegistration('venue-1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tryFetch).not.toHaveBeenCalled();
    // One deferral warning, not one per attempt.
    expect(logger.warn).toHaveBeenCalledTimes(1);

    ifaces({
      'vEthernet (Default Switch)': [['172.28.0.1']],
      Ethernet: [['192.168.1.50']],
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(tryFetch).toHaveBeenCalledTimes(1);
  });

  it('accepts a virtual-only address once the DHCP window has passed', async () => {
    ifaces({ 'vEthernet (External)': [['192.168.1.60']] });
    const { api, logger, tryFetch } = await load();
    tryFetch.mockResolvedValue(okResponse as any);

    api.startPrinterServerIpRegistration('venue-2');
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 15_000);

    expect(tryFetch).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'Registering printer server IP: 192.168.1.60 for venue: venue-2'
    );
  });

  it('never replaces a registered physical address with a virtual one', async () => {
    ifaces({ Ethernet: [['192.168.1.50']] });
    const { api, tryFetch } = await load();
    tryFetch.mockResolvedValue(okResponse as any);

    api.startPrinterServerIpRegistration('venue-7');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tryFetch).toHaveBeenCalledTimes(1);

    // The NIC drops long after the DHCP grace window; the WSL address that is
    // left must not be published over the venue's real one.
    ifaces({ 'vEthernet (WSL)': [['172.28.0.1']] });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(tryFetch).toHaveBeenCalledTimes(1);

    ifaces({ Ethernet: [['192.168.1.77']] });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tryFetch).toHaveBeenCalledTimes(2);
  });

  it('still follows a virtual address it registered itself', async () => {
    ifaces({ 'vEthernet (External)': [['192.168.1.60']] });
    const { api, tryFetch } = await load();
    tryFetch.mockResolvedValue(okResponse as any);

    api.startPrinterServerIpRegistration('venue-8');
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 15_000);
    expect(tryFetch).toHaveBeenCalledTimes(1);

    // A Hyper-V external switch is the machine's only adapter, so its new
    // lease is still the address the FE has to reach.
    ifaces({ 'vEthernet (External)': [['192.168.1.61']] });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tryFetch).toHaveBeenCalledTimes(2);
  });

  it('retries until the backend confirms, then stops', async () => {
    ifaces({ Ethernet: [['192.168.1.50']] });
    const { api, logger, tryFetch } = await load();
    tryFetch
      .mockRejectedValueOnce(new Error('fetch and curl both failed'))
      .mockResolvedValueOnce({
        ...okResponse,
        data: { data: { updatePrinterServerIp: { status: 'pending' } } },
      } as any)
      .mockResolvedValue(okResponse as any);

    api.startPrinterServerIpRegistration('venue-3');
    await vi.advanceTimersByTimeAsync(45_000);

    expect(tryFetch).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      'Printer server IP registered successfully'
    );

    // Confirmed: nothing more to say while the address stays the same.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tryFetch).toHaveBeenCalledTimes(3);
  });

  it('re-registers when the LAN IP changes', async () => {
    ifaces({ Ethernet: [['192.168.1.50']] });
    const { api, logger, tryFetch } = await load();
    tryFetch.mockResolvedValue(okResponse as any);

    api.startPrinterServerIpRegistration('venue-5');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(tryFetch).toHaveBeenCalledTimes(1);

    // A new DHCP lease used to sit unpublished until the next restart.
    ifaces({ Ethernet: [['192.168.1.77']] });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(tryFetch).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      'LAN IP changed 192.168.1.50 -> 192.168.1.77, re-registering'
    );
  });

  it('keeps retrying a change the backend did not confirm', async () => {
    ifaces({ Ethernet: [['192.168.1.50']] });
    const { api, tryFetch } = await load();
    tryFetch.mockResolvedValue(okResponse as any);

    api.startPrinterServerIpRegistration('venue-6');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tryFetch).toHaveBeenCalledTimes(1);

    // The new address must not be remembered as registered until confirmed.
    tryFetch.mockRejectedValue(new Error('fetch and curl both failed'));
    ifaces({ Ethernet: [['192.168.1.77']] });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 45_000);
    expect(tryFetch.mock.calls.length).toBeGreaterThan(2);
  });

  it('collapses the logs of a sustained outage and backs off', async () => {
    ifaces({ Ethernet: [['192.168.1.50']] });
    const { api, logger, tryFetch } = await load();
    tryFetch.mockRejectedValue(new Error('fetch and curl both failed'));

    api.startPrinterServerIpRegistration('venue-4');
    await vi.advanceTimersByTimeAsync(60 * 60_000);

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
