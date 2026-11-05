// No top-level import/export of its own, so TS would treat this as a global
// script and collide `load` with the other suites.
export {};

jest.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

type Http = typeof import('../src/modules/http');
type Logger = typeof import('../src/modules/logger').default;

const load = () => {
  let http!: Http;
  let logger!: Logger;
  jest.isolateModules(() => {
    http = require('../src/modules/http');
    logger = require('../src/modules/logger').default;
  });
  return { http, logger: logger as jest.Mocked<Logger> };
};

const URL_A = 'https://backend.test/print-jobs/result';

const connectFail = (code: string) => {
  const err: any = new TypeError('fetch failed');
  err.cause = { code };
  return err;
};

// The endpoints object of the stats line logged at `level`.
const statsLine = (logger: jest.Mocked<Logger>, level: 'info' | 'warn') => {
  const call = logger[level].mock.calls.find((c) => c[1] === 'fetch stats');
  return (call?.[0] as any)?.endpoints;
};

describe('fetch retry policy', () => {
  it('goes straight to curl on a connect timeout instead of retrying fetch', () => {
    const { http } = load();
    expect(http.isCheapRetryableFetchError(connectFail('ETIMEDOUT'))).toBe(
      false
    );
    expect(
      http.isCheapRetryableFetchError(connectFail('UND_ERR_CONNECT_TIMEOUT'))
    ).toBe(false);
    expect(http.isCheapRetryableFetchError(connectFail('ECONNRESET'))).toBe(
      true
    );
  });

  it('does not retry an ETIMEDOUT fetch before falling back', async () => {
    const { http } = load();
    const fetchFn = jest.fn(async () => {
      throw connectFail('ETIMEDOUT');
    });
    const result = await http.tryFetchWithFallback({
      curlFn: async () => 'curl',
      fetchFn,
      fetchRetries: 2,
      method: 'POST',
      shouldRetry: http.isCheapRetryableFetchError,
      url: URL_A,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.data).toBe('curl');
  });
});

describe('fetch stats line', () => {
  it('counts each outcome per endpoint and logs a failing window as warn', async () => {
    const { http, logger } = load();
    const ok = async () => ({ data: 'fetch' });

    await http.tryFetchWithFallback({
      curlFn: async () => 'curl',
      fetchFn: ok,
      method: 'POST',
      url: URL_A,
    });
    let attempts = 0;
    await http.tryFetchWithFallback({
      curlFn: async () => 'curl',
      fetchFn: async () => {
        attempts += 1;
        if (attempts === 1) throw connectFail('ECONNRESET');
        return { data: 'fetch' };
      },
      fetchRetries: 1,
      method: 'POST',
      retryDelayMs: 0,
      url: URL_A,
    });
    await http.tryFetchWithFallback({
      curlFn: async () => 'curl',
      fetchFn: async () => {
        throw connectFail('UND_ERR_CONNECT_TIMEOUT');
      },
      method: 'POST',
      url: URL_A,
    });
    await expect(
      http.tryFetchWithFallback({
        curlFn: async () => {
          throw new Error('curl down');
        },
        fetchFn: async () => {
          throw Object.assign(new Error('HTTP 503'), { responseStatus: 503 });
        },
        method: 'POST',
        url: URL_A,
      })
    ).rejects.toThrow();
    await http.tryFetchWithFallback({
      curlFirst: true,
      curlFn: async () => 'curl',
      fetchFn: ok,
      method: 'POST',
      url: URL_A,
    });

    http.flushFetchStats();

    expect(statsLine(logger, 'info')).toBeUndefined();
    expect(statsLine(logger, 'warn')).toEqual({
      'POST backend.test/print-jobs/result': {
        curlOnly: 1,
        curlRecovered: 1,
        failed: 1,
        fetchErrors: {
          ECONNRESET: 1,
          HTTP_503: 1,
          UND_ERR_CONNECT_TIMEOUT: 1,
        },
        fetchOk: 1,
        fetchOkAfterRetry: 1,
      },
    });
    http.resetFetchStatsForTests();
  });

  it('logs a clean window as info, and nothing when there was no traffic', async () => {
    const { http, logger } = load();
    await http.tryFetchWithFallback({
      curlFn: async () => 'curl',
      fetchFn: async () => ({ data: 'fetch' }),
      method: 'GET',
      url: 'https://api.github.com/repos/x/releases/latest?q=1',
    });

    http.flushFetchStats();
    expect(statsLine(logger, 'warn')).toBeUndefined();
    expect(statsLine(logger, 'info')).toEqual({
      'GET api.github.com/repos/x/releases/latest': expect.objectContaining({
        fetchErrors: {},
        fetchOk: 1,
      }),
    });

    logger.info.mockClear();
    http.flushFetchStats();
    expect(logger.info).not.toHaveBeenCalled();
    http.resetFetchStatsForTests();
  });

  it('flushes on its own every window', async () => {
    jest.useFakeTimers();
    try {
      const { http, logger } = load();
      await http.tryFetchWithFallback({
        curlFn: async () => 'curl',
        fetchFn: async () => ({ data: 'fetch' }),
        method: 'POST',
        url: URL_A,
      });
      jest.advanceTimersByTime(http.FETCH_STATS_INTERVAL_MS);
      expect(statsLine(logger, 'info')).toBeDefined();
      http.resetFetchStatsForTests();
    } finally {
      jest.useRealTimers();
    }
  });

  it('folds open-ended paths into their host past the endpoint cap', async () => {
    const { http, logger } = load();
    for (let i = 0; i < 30; i++) {
      await http.tryFetchWithFallback({
        curlFn: async () => Buffer.alloc(0),
        fetchFn: async () => ({ data: Buffer.alloc(0) }),
        method: 'GET',
        url: `https://cdn.test/img-${i}.png`,
      });
    }
    http.flushFetchStats();
    const endpoints = statsLine(logger, 'info');
    expect(Object.keys(endpoints)).toHaveLength(26);
    expect(endpoints['GET cdn.test/*'].fetchOk).toBe(5);
    http.resetFetchStatsForTests();
  });
});
