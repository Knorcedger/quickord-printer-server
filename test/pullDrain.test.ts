import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No top-level import/export of its own, so TS would treat this as a global
// script and collide `load` with the other pull-loop suites.
export {};

/**
 * The drain an update runs before the updater child stops the service: no new
 * claims, and every claimed print reaches paper and reports first.
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

vi.mock('../src/modules/api', () => ({ reportFetchFailure: vi.fn() }));
vi.mock('../src/modules/backendUrl', () => ({
  getBackendBaseUrl: () => 'https://backend.test',
}));
vi.mock('../src/modules/network', () => ({
  __esModule: true,
  default: vi.fn(),
}));
vi.mock('../src/modules/printer', () => ({
  checkPrinters: vi.fn(async () => []),
}));
vi.mock('../src/modules/applySettings', () => ({
  applyDesiredSettings: vi.fn(),
}));
vi.mock('../src/modules/settings', () => ({ getSyncedHash: () => 'h1' }));

const psIdentity = {
  getPrinterVersion: () => 'v-test',
  getVenueId: vi.fn(() => 'venue-1'),
  getWsSecret: vi.fn(() => 'secret'),
  triggerRestart: vi.fn(),
};
vi.mock('../src/modules/psIdentity', () => psIdentity);

// How long the printer takes to accept a job; Infinity never answers.
let printMs = 5_000;
vi.mock('../src/modules/printJob', () => ({
  executePrintJob: vi.fn((job: any, report: any) => {
    if (Number.isFinite(printMs)) {
      setTimeout(() => report(job.jobId, 'success'), printMs);
    }
  }),
}));

const POLL_HOLD_MS = 20_000;

let polls = 0;
let queued: any[] = [];
let results: string[] = [];

const tick = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const jsonResponse = (payload: unknown) => ({
  json: async () => payload,
  ok: true,
  status: 200,
});

const fakeBackend = async (url: string, init: any) => {
  const body = JSON.parse(init.body);

  if (url.endsWith('/print-jobs/result')) {
    results.push(body.jobId);
    return jsonResponse({ ok: true });
  }
  polls += 1;
  const deadline = Date.now() + POLL_HOLD_MS;
  while (Date.now() < deadline) {
    if (queued.length) {
      const jobs = queued;
      queued = [];
      return jsonResponse({ jobs });
    }
    await tick(100);
  }
  return jsonResponse({ jobs: [] });
};

const load = async () => {
  vi.resetModules();
  const pullClient: typeof import('../src/modules/pullClient') =
    await import('../src/modules/pullClient');
  return pullClient;
};

const job = (jobId: string) => ({ data: 'AA==', jobId, printerIp: '1.2.3.4' });

describe('draining the pull loop before an update handoff', () => {
  let pullClient: Awaited<ReturnType<typeof load>>;

  beforeEach(async () => {
    vi.useFakeTimers({ toNotFake: ['nextTick'] });
    polls = 0;
    queued = [];
    results = [];
    printMs = 5_000;
    global.fetch = vi.fn(fakeBackend) as any;
    pullClient = await load();
  });

  afterEach(async () => {
    // Leave no loop polling into the next test.
    void pullClient.pausePullClient(0);
    await vi.advanceTimersByTimeAsync(2 * POLL_HOLD_MS);
    vi.useRealTimers();
  });

  it('waits for the held poll and its prints, then stops claiming', async () => {
    pullClient.initPullClient();
    await vi.advanceTimersByTimeAsync(1_000);

    let drained: boolean | undefined;
    void pullClient.pausePullClient(45_000).then((d) => {
      drained = d;
    });
    // A job that lands on the poll already held when the drain began.
    queued = [job('late')];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drained).toBeUndefined();

    await vi.advanceTimersByTimeAsync(printMs);
    expect(drained).toBe(true);
    expect(results).toEqual(['late']);

    const pollsAtDrain = polls;
    await vi.advanceTimersByTimeAsync(3 * POLL_HOLD_MS);
    expect(polls).toBe(pollsAtDrain);
  });

  it('gives up at the cap when a print never finishes', async () => {
    printMs = Infinity;
    pullClient.initPullClient();
    queued = [job('stuck')];
    await vi.advanceTimersByTimeAsync(1_000);

    let drained: boolean | undefined;
    void pullClient.pausePullClient(45_000).then((d) => {
      drained = d;
    });
    await vi.advanceTimersByTimeAsync(44_000);
    expect(drained).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drained).toBe(false);
  });

  it('polls again when the handoff does not happen', async () => {
    pullClient.initPullClient();
    await vi.advanceTimersByTimeAsync(1_000);
    void pullClient.pausePullClient(45_000);
    // Resumed while the paused loop is still on its held poll.
    pullClient.initPullClient();
    await vi.advanceTimersByTimeAsync(POLL_HOLD_MS);

    queued = [job('after')];
    await vi.advanceTimersByTimeAsync(1_000 + printMs);
    expect(results).toEqual(['after']);
  });
});
