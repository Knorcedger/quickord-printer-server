import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No top-level import/export of its own, so TS would treat this as a global
// script and collide `load` with the other pull-loop suites.
export {};

/**
 * A machine whose fetch is broken (firewall, proxy) while curl works: the poll
 * keeps falling back to curl, and once that is a streak the result reports stop
 * spending their attempt on fetch and go straight to curl.
 */
vi.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const api = { reportFetchFailure: vi.fn(() => Promise.resolve()) };
vi.mock('../src/modules/api', () => api);
vi.mock('../src/modules/backendUrl', () => ({
  getBackendBaseUrl: () => 'https://backend.test',
}));
vi.mock('../src/modules/network', () => ({
  __esModule: true,
  default: vi.fn(),
}));
vi.mock('../src/modules/printer', () => ({ checkPrinters: vi.fn() }));
vi.mock('../src/modules/printJob', () => ({
  executePrintJob: vi.fn((job: any, cb: any) => cb(job.jobId, 'success')),
}));

const psIdentity = {
  getPrinterVersion: () => 'v-test',
  getVenueId: vi.fn(() => 'venue-1'),
  getWsSecret: vi.fn(() => 'secret'),
  triggerRestart: vi.fn(),
};
vi.mock('../src/modules/psIdentity', () => psIdentity);
vi.mock('../src/modules/settings', () => ({ getSyncedHash: () => 'h1' }));
vi.mock('../src/modules/applySettings', () => ({
  applyDesiredSettings: vi.fn(),
}));

const tick = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let polls = 0;
let queued: any[] = [];
const curlResults: string[] = [];

vi.mock('../src/modules/http', async () => {
  const actual = await vi.importActual('../src/modules/http');
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

const load = async () => {
  let pullClient!: typeof import('../src/modules/pullClient');
  vi.resetModules();
  pullClient = await import('../src/modules/pullClient');
  return pullClient;
};

describe('result reports on a machine where fetch is broken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toNotFake: ['nextTick'] });
    polls = 0;
    queued = [];
    curlResults.length = 0;
    fetchResults.length = 0;
    psIdentity.getVenueId.mockReturnValue('venue-1');
    global.fetch = vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/print-jobs/result')) {
        fetchResults.push(init.body);
        return { json: async () => ({ ok: true }), ok: true, status: 200 };
      }
      throw connectTimeout();
    }) as any;
  });

  afterEach(async () => {
    psIdentity.getVenueId.mockReturnValue('');
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
  });

  it('tries fetch first, then goes curl-only once the poll streak shows fetch is broken', async () => {
    const pullClient = await load();
    queued = [{ data: '', jobId: 'early', printerIp: '1.1.1.1' }];
    pullClient.initPullClient();
    await vi.advanceTimersByTimeAsync(1_500);

    // One fallback is not a streak: the report still goes over fetch.
    expect(fetchResults).toHaveLength(1);
    expect(curlResults).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls).toBeGreaterThanOrEqual(3);

    queued = [{ data: '', jobId: 'late', printerIp: '1.1.1.1' }];
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchResults).toHaveLength(1);
    expect(curlResults).toHaveLength(1);
    expect(curlResults[0]).toContain('--connect-timeout 20');
    // The whole attempt budget, not the remainder after a fetch.
    expect(curlResults[0]).toMatch(/-m 30 /);
  });

  it('raises one incident for the poll streak and none for single fallbacks', async () => {
    const pullClient = await load();
    pullClient.initPullClient();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(api.reportFetchFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.reportFetchFailure).toHaveBeenCalledTimes(1);
    expect(api.reportFetchFailure).toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveFallbacks: 3 })
    );
  });
});
