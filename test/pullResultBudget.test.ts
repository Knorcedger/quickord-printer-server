// No top-level import/export of its own, so TS would treat this as a global
// script and collide `load` with the other pull-loop suites.
export {};

/**
 * Result-report timing on a slow uplink: each attempt has a 30s budget (fetch
 * up to 25s, curl the rest, at least 5s), and there are 3 attempts 2s and 5s
 * apart, so the chain ends inside the backend's 120s claim-result sweep.
 */
const logger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};
jest.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: logger,
}));
jest.mock('../src/modules/api', () => ({
  reportFetchFailure: jest.fn(() => Promise.resolve()),
}));
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

type Step = (init: any) => Promise<any>;

// Scripted result-report behaviour, consumed one step per call. Unscripted
// calls acknowledge, so teardown never leaves a chain retrying.
let fetchSteps: Step[] = [];
let curlSteps: Step[] = [];
let resultFetchAt: number[] = [];
let resultCurls: { at: number; cmd: string }[] = [];
let queued: any[] = [];
let polls = 0;
let t0 = 0;

const ack = { ok: true };
const ackResponse = { json: async () => ack, ok: true, status: 200 };

jest.mock('../src/modules/http', () => {
  const actual = jest.requireActual('../src/modules/http');
  return {
    ...actual,
    curlExecJson: async (cmd: string) => {
      resultCurls.push({ at: Date.now() - t0, cmd });
      const step = curlSteps.shift();
      return step ? step(undefined) : ack;
    },
    withTempJsonPayload: (_body: unknown, fn: (p: string) => unknown) =>
      fn('payload.json'),
  };
});

const abortError = () => {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
};

const connReset = () => {
  const err: any = new TypeError('fetch failed');
  err.cause = { code: 'ECONNRESET' };
  return err;
};

// Fetch hangs until postJson's 25s timer aborts it.
const hangUntilAbort: Step = (init) =>
  new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(abortError()));
  });

// Fetch fails on its own after `ms`, ignoring the abort.
const failAfter =
  (ms: number): Step =>
  async () => {
    await tick(ms);
    throw connReset();
  };

const respondAck: Step = async () => ackResponse;

const curlFailAfter =
  (ms: number): Step =>
  async () => {
    await tick(ms);
    throw Object.assign(new Error('curl: (28) Operation timed out'), {
      stderr: 'curl: (28) Operation timed out',
    });
  };

const curlTimeoutS = (cmd: string) => Number(/ -m (\d+) /.exec(cmd)?.[1]);

const gaveUpLogs = () =>
  logger.error.mock.calls.filter(
    ([msg]) =>
      typeof msg === 'string' && msg.startsWith('Failed to report print result')
  );

const load = () => {
  let pullClient!: typeof import('../src/modules/pullClient');
  jest.isolateModules(() => {
    pullClient = require('../src/modules/pullClient');
  });
  return pullClient;
};

// Starts the loop with one job queued; its report starts on the first poll.
const startWithOneJob = async () => {
  queued = [{ data: '', jobId: 'job-1', printerIp: '1.1.1.1' }];
  load().initPullClient();
  await jest.advanceTimersByTimeAsync(1_000);
  expect(resultFetchAt).toHaveLength(1);
};

describe('result report budget and retries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    fetchSteps = [];
    curlSteps = [];
    resultFetchAt = [];
    resultCurls = [];
    queued = [];
    polls = 0;
    t0 = 0;
    psIdentity.getVenueId.mockReturnValue('venue-1');
    global.fetch = jest.fn(async (url: string, init: any) => {
      if (url.endsWith('/print-jobs/poll')) {
        // A real answer takes time; also keeps the loop off a microtask spin.
        await tick(1_000);
        polls += 1;
        const jobs = queued;
        queued = [];
        return { json: async () => ({ jobs }), ok: true, status: 200 };
      }
      if (url.endsWith('/print-jobs/result')) {
        if (resultFetchAt.length === 0) t0 = Date.now();
        resultFetchAt.push(Date.now() - t0);
        const step = fetchSteps.shift();
        return step ? step(init) : ackResponse;
      }
      return ackResponse;
    }) as any;
  });

  afterEach(async () => {
    psIdentity.getVenueId.mockReturnValue('');
    await jest.advanceTimersByTimeAsync(150_000);
    jest.useRealTimers();
  });

  it('gives curl only what the fetch left of the attempt', async () => {
    fetchSteps = [failAfter(22_000)];
    await startWithOneJob();

    await jest.advanceTimersByTimeAsync(22_000);
    expect(resultCurls).toHaveLength(1);
    expect(resultCurls[0]!.at).toBe(22_000);
    expect(curlTimeoutS(resultCurls[0]!.cmd)).toBe(8);

    // curl acknowledged: no further attempts.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(resultFetchAt).toHaveLength(1);
    expect(resultCurls).toHaveLength(1);
    expect(gaveUpLogs()).toHaveLength(0);
  });

  it('gives curl the whole remainder after a timed-out fetch', async () => {
    fetchSteps = [hangUntilAbort];
    await startWithOneJob();

    await jest.advanceTimersByTimeAsync(25_000);
    expect(resultCurls).toHaveLength(1);
    expect(resultCurls[0]!.at).toBe(25_000);
    expect(curlTimeoutS(resultCurls[0]!.cmd)).toBe(5);
  });

  it('never gives curl less than 5s, even when the fetch overran the budget', async () => {
    fetchSteps = [failAfter(28_000)];
    await startWithOneJob();

    await jest.advanceTimersByTimeAsync(28_000);
    expect(resultCurls).toHaveLength(1);
    expect(curlTimeoutS(resultCurls[0]!.cmd)).toBe(5);
  });

  it('stops after 3 failed attempts, 2s and 5s apart, while polling continues', async () => {
    fetchSteps = [hangUntilAbort, hangUntilAbort, hangUntilAbort];
    curlSteps = [
      curlFailAfter(5_000),
      curlFailAfter(5_000),
      curlFailAfter(5_000),
    ];
    await startWithOneJob();
    const pollsAtStart = polls;

    // Each attempt: 25s fetch + 5s curl. Then 2s, then 5s before the next.
    await jest.advanceTimersByTimeAsync(97_000);
    expect(resultFetchAt).toEqual([0, 32_000, 67_000]);
    expect(resultCurls.map((c) => c.at)).toEqual([25_000, 57_000, 92_000]);
    expect(resultCurls.map((c) => curlTimeoutS(c.cmd))).toEqual([5, 5, 5]);
    expect(gaveUpLogs()).toHaveLength(1);
    expect(gaveUpLogs()[0]![0]).toContain('after 3 attempts');

    // No fourth attempt.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(resultFetchAt).toHaveLength(3);
    expect(resultCurls).toHaveLength(3);

    // The report chain never held up the poll loop.
    expect(polls - pollsAtStart).toBeGreaterThanOrEqual(90);
  });

  it('stops retrying once a later attempt is acknowledged, while polling continues', async () => {
    fetchSteps = [hangUntilAbort, respondAck];
    curlSteps = [curlFailAfter(5_000)];
    await startWithOneJob();
    const pollsAtStart = polls;

    await jest.advanceTimersByTimeAsync(32_000);
    expect(resultFetchAt).toEqual([0, 32_000]);
    expect(resultCurls).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(resultFetchAt).toHaveLength(2);
    expect(resultCurls).toHaveLength(1);
    expect(gaveUpLogs()).toHaveLength(0);
    expect(polls - pollsAtStart).toBeGreaterThanOrEqual(85);
  });
});
