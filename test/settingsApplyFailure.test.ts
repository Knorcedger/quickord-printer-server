/**
 * What the pull loop does while the settings it is handed will not apply — an
 * unwritable settings.json is the case this exists for. The rule: the failure
 * costs the config, never the paper. The backend does the pacing, because only
 * it can slow the retries down without closing the channel jobs arrive on.
 *
 * The fake backend below mirrors the real one (pullApi.ts): it holds a poll for
 * POLL_HOLD_MS, answers the moment a job is queued, and short-circuits the hold
 * when it has settings to hand over — unless the PS says it cannot take them.
 */
jest.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.mock('../src/modules/api', () => ({ reportFetchFailure: jest.fn() }));
jest.mock('../src/modules/backendUrl', () => ({
  getBackendBaseUrl: () => 'https://backend.test',
}));
jest.mock('../src/modules/network', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('../src/modules/printer', () => ({
  checkPrinters: jest.fn(async () => []),
}));
jest.mock('../src/modules/printJob', () => ({ executePrintJob: jest.fn() }));

const psIdentity = {
  getPrinterVersion: () => 'v-test',
  getVenueId: jest.fn(() => 'venue-1'),
  getWsSecret: jest.fn(() => 'secret'),
  triggerRestart: jest.fn(),
};
jest.mock('../src/modules/psIdentity', () => psIdentity);

// The hash the settings module reports after an apply — the only signal the
// pull loop has that the settings it was handed were actually taken.
const settings = { getSyncedHash: jest.fn(() => 'h1') };
jest.mock('../src/modules/settings', () => settings);

const applySettings = { applyDesiredSettings: jest.fn() };
jest.mock('../src/modules/applySettings', () => applySettings);

// The backend's own hold (pullApi.ts POLL_HOLD_MS) and the deadlines a stalled
// channel breaks: a command's round trip and a job's freshness window.
const POLL_HOLD_MS = 20_000;
const COMMAND_TIMEOUT_MS = 25_000;
const JOB_FRESHNESS_MS = 60_000;
const DESIRED_HASH = 'h2';

type Poll = { at: number; body: any };

let polls: Poll[] = [];
let queued: any[] = [];
// A backend that ignores settingsApplyFailed: what a rollback, or a PS that
// ships ahead of the backend, actually talks to.
let ignoresTheFlag = false;
// A venue printing flat out: there is always another job waiting.
let alwaysBusy = false;

const pollAt = (i: number): Poll => polls[i] as Poll;
const lastPoll = (): Poll => polls[polls.length - 1] as Poll;

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
  if (url.endsWith('/print-jobs/result')) return jsonResponse({ ok: true });

  polls.push({ at: Date.now(), body });
  const settingsPayload =
    body.settingsHash === DESIRED_HASH
      ? undefined
      : {
          settings: { modems: [], printers: [], venueId: 'venue-1' },
          settingsHash: DESIRED_HASH,
        };
  // Settings in hand answer at once so the PS takes them immediately — but not
  // when it has already told us it cannot write them, or the two would spin.
  const answerAtOnce =
    settingsPayload && (ignoresTheFlag || !body.settingsApplyFailed);

  if (alwaysBusy) {
    // The round trip, so the loop advances the clock instead of spinning in
    // microtasks: a real answer never arrives in zero time.
    await tick(50);
    queued.push({
      data: '',
      jobId: `busy-${polls.length}`,
      printerIp: '1.1.1.1',
    });
  }

  const deadline = Date.now() + POLL_HOLD_MS;
  while (Date.now() < deadline) {
    if (queued.length) {
      const jobs = queued;
      queued = [];
      return jsonResponse({ jobs, ...settingsPayload });
    }
    if (answerAtOnce) break;
    await tick(100);
  }
  return jsonResponse({ jobs: [], ...settingsPayload });
};

const load = () => {
  let pullClient!: typeof import('../src/modules/pullClient');
  let executePrintJob!: jest.Mock;
  let checkPrinters!: jest.Mock;
  jest.isolateModules(() => {
    pullClient = require('../src/modules/pullClient');
    executePrintJob = require('../src/modules/printJob').executePrintJob;
    checkPrinters = require('../src/modules/printer').checkPrinters;
  });
  return { checkPrinters, executePrintJob, pullClient };
};

// The loop has no stop switch: dropping the creds parks it on its no-creds
// wait instead of leaving a poll in flight after the test.
const parkLoop = async () => {
  psIdentity.getVenueId.mockReturnValue('');
  await jest.advanceTimersByTimeAsync(60_000);
  psIdentity.getVenueId.mockReturnValue('venue-1');
};

describe('polling while the settings will not apply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    polls = [];
    queued = [];
    ignoresTheFlag = false;
    alwaysBusy = false;
    psIdentity.getVenueId.mockReturnValue('venue-1');
    settings.getSyncedHash.mockReturnValue('h1');
    // Writing settings.json failed: applyDesiredSettings resolves, but the hash
    // it was handed was never taken — which is what the loop must notice.
    applySettings.applyDesiredSettings.mockResolvedValue({});
    global.fetch = jest.fn(fakeBackend) as any;
  });

  afterEach(async () => {
    await parkLoop();
    jest.useRealTimers();
  });

  it('tells the backend it could not take them, and stops once it can', async () => {
    const { pullClient } = load();

    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(3 * POLL_HOLD_MS);

    // Nothing had failed yet on the first poll; every later one carries it.
    expect(pollAt(0).body.settingsApplyFailed).toBe(false);
    expect(pollAt(1).body.settingsApplyFailed).toBe(true);

    // The disk comes back: the next apply takes the hash, and the flag clears.
    applySettings.applyDesiredSettings.mockImplementation(async () => {
      settings.getSyncedHash.mockReturnValue(DESIRED_HASH);
    });
    await jest.advanceTimersByTimeAsync(3 * POLL_HOLD_MS);

    expect(lastPoll().body.settingsApplyFailed).toBe(false);
  });

  it('keeps printing while the failure lasts', async () => {
    const { executePrintJob, pullClient } = load();

    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(300_000);
    expect(polls.length).toBeGreaterThan(5);

    // A receipt queued deep into the failure episode, with nothing else in
    // flight: it has to reach the printer inside the backend's freshness
    // window, or it ages out unprinted.
    const queuedAt = Date.now();
    queued = [{ data: '', jobId: 'job-1', printerIp: '1.2.3.4' }];
    await jest.advanceTimersByTimeAsync(JOB_FRESHNESS_MS);

    expect(executePrintJob).toHaveBeenCalledTimes(1);
    const deliveredAt = lastPoll().at;
    expect(deliveredAt - queuedAt).toBeLessThan(JOB_FRESHNESS_MS);
  });

  it('keeps running control commands while the failure lasts', async () => {
    const { checkPrinters, pullClient } = load();

    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(300_000);

    // The backend gives up on a command after COMMAND_TIMEOUT_MS and answers
    // the user a fallback, so a loop parked longer than that is a dead button.
    queued = [{ data: '', jobId: 'cmd-1', type: 'checkPrinters' }];
    await jest.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);

    expect(checkPrinters).toHaveBeenCalledTimes(1);
  });

  it('delivers a whole burst, not one claim per pause', async () => {
    const { executePrintJob, pullClient } = load();

    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(300_000);

    // The backend hands over at most 20 jobs per claim; the rest wait for the
    // next poll and expire if that poll is a minute away.
    queued = Array.from({ length: 20 }, (_, i) => ({
      data: '',
      jobId: `burst-a-${i}`,
      printerIp: '1.2.3.4',
    }));
    await jest.advanceTimersByTimeAsync(1_000);
    queued = Array.from({ length: 5 }, (_, i) => ({
      data: '',
      jobId: `burst-b-${i}`,
      printerIp: '1.2.3.4',
    }));
    await jest.advanceTimersByTimeAsync(JOB_FRESHNESS_MS);

    expect(executePrintJob).toHaveBeenCalledTimes(25);
  });

  it('adds no pause of its own while the backend holds the poll', async () => {
    const { pullClient } = load();

    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(300_000);

    // One poll per hold, give or take the round trip. Anything much lower is
    // the loop sleeping between polls again.
    expect(polls.length).toBeGreaterThanOrEqual(14);
  });

  it('does not pause a busy venue on a backend that never holds', async () => {
    // Jobs answer at once by design, so on such a backend a venue that is
    // actually printing would take the anti-spin floor on every batch. An
    // answer that carried work is not a spin.
    ignoresTheFlag = true;
    alwaysBusy = true;
    const { executePrintJob, pullClient } = load();

    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(30_000);

    // Every answer here carries a job, so nothing may pace them: at the 5s
    // floor this window would be ~6 prints instead of hundreds.
    expect(executePrintJob.mock.calls.length).toBeGreaterThan(50);
  });

  it('does not spin against a backend that answers without holding', async () => {
    // A backend that predates the flag short-circuits its hold on every poll
    // while we are out of sync. Nothing paces the loop but us.
    ignoresTheFlag = true;
    const { pullClient } = load();

    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(60_000);

    // ~12 at the 5s floor; hundreds without one.
    expect(polls.length).toBeLessThan(20);
    // Still short enough that a job in the next answer beats every deadline.
    expect(polls.length).toBeGreaterThan(5);
  });
});
