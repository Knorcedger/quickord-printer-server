// No top-level import/export of its own, so TS would treat this as a global
// script and collide `load` with the other pull-loop suites.
export {};

/**
 * A machine whose fetch is broken (firewall, proxy) while curl works: the poll
 * keeps falling back to curl, and once that is a streak the result reports stop
 * spending their attempt on fetch and go straight to curl.
 */
jest.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const api = { reportFetchFailure: jest.fn(() => Promise.resolve()) };
jest.mock('../src/modules/api', () => api);
jest.mock('../src/modules/backendUrl', () => ({
  getBackendBaseUrl: () => 'https://backend.test',
}));
jest.mock('../src/modules/network', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('../src/modules/printer', () => ({ checkPrinters: jest.fn() }));
jest.mock('../src/modules/printJob', () => ({
  executePrintJob: jest.fn((job: any, cb: any) => cb(job.jobId, 'success')),
}));

const psIdentity = {
  getPrinterVersion: () => 'v-test',
  getVenueId: jest.fn(() => 'venue-1'),
  getWsSecret: jest.fn(() => 'secret'),
  triggerRestart: jest.fn(),
};
jest.mock('../src/modules/psIdentity', () => psIdentity);
jest.mock('../src/modules/settings', () => ({ getSyncedHash: () => 'h1' }));
jest.mock('../src/modules/applySettings', () => ({
  applyDesiredSettings: jest.fn(),
}));

const tick = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let polls = 0;
let queued: any[] = [];
const curlResults: string[] = [];

jest.mock('../src/modules/http', () => {
  const actual = jest.requireActual('../src/modules/http');
  return {
    ...actual,
    curlExecJson: async (cmd: string) => {
      if (cmd.includes('/print-jobs/poll')) {
        // A real answer takes time; also keeps the loop off a microtask spin.
        await tick(1_000);
        polls += 1;
        const jobs = queued;
        queued = [];
        return { jobs };
      }
      curlResults.push(cmd);
      return { ok: true };
    },
    withTempJsonPayload: (_body: unknown, fn: (p: string) => unknown) =>
      fn('payload.json'),
  };
});

const fetchResults: string[] = [];

const connectTimeout = () => {
  const err: any = new TypeError('fetch failed');
  err.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
  return err;
};

const load = () => {
  let pullClient!: typeof import('../src/modules/pullClient');
  jest.isolateModules(() => {
    pullClient = require('../src/modules/pullClient');
  });
  return pullClient;
};

describe('result reports on a machine where fetch is broken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    polls = 0;
    queued = [];
    curlResults.length = 0;
    fetchResults.length = 0;
    psIdentity.getVenueId.mockReturnValue('venue-1');
    global.fetch = jest.fn(async (url: string, init: any) => {
      if (url.endsWith('/print-jobs/result')) {
        fetchResults.push(init.body);
        return { json: async () => ({ ok: true }), ok: true, status: 200 };
      }
      throw connectTimeout();
    }) as any;
  });

  afterEach(async () => {
    psIdentity.getVenueId.mockReturnValue('');
    await jest.advanceTimersByTimeAsync(60_000);
    jest.useRealTimers();
  });

  it('tries fetch first, then goes curl-only once the poll streak shows fetch is broken', async () => {
    const pullClient = load();
    queued = [{ data: '', jobId: 'early', printerIp: '1.1.1.1' }];
    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(1_500);

    // One fallback is not a streak: the report still goes over fetch.
    expect(fetchResults).toHaveLength(1);
    expect(curlResults).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(polls).toBeGreaterThanOrEqual(3);

    queued = [{ data: '', jobId: 'late', printerIp: '1.1.1.1' }];
    await jest.advanceTimersByTimeAsync(2_000);

    expect(fetchResults).toHaveLength(1);
    expect(curlResults).toHaveLength(1);
    expect(curlResults[0]).toContain('--connect-timeout 20');
    // The whole attempt budget, not the remainder after a fetch.
    expect(curlResults[0]).toMatch(/-m 30 /);
  });

  it('raises one incident for the poll streak and none for single fallbacks', async () => {
    const pullClient = load();
    pullClient.initPullClient();

    await jest.advanceTimersByTimeAsync(1_500);
    expect(api.reportFetchFailure).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10_000);
    expect(api.reportFetchFailure).toHaveBeenCalledTimes(1);
    expect(api.reportFetchFailure).toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveFallbacks: 3 })
    );
  });
});
