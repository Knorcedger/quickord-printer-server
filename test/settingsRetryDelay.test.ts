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
jest.mock('../src/modules/printer', () => ({ checkPrinters: jest.fn() }));
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

jest.mock('../src/modules/http', () => ({
  __esModule: true,
  curlExecJson: jest.fn(),
  httpStatusError: jest.fn(),
  isCheapRetryableFetchError: () => true,
  isRecoveredFetchNoise: () => false,
  tryFetchWithFallback: jest.fn(),
  withTempJsonPayload: jest.fn(),
}));

type Http = typeof import('../src/modules/http');

const load = () => {
  let pullClient!: typeof import('../src/modules/pullClient');
  let http!: Http;
  let executePrintJob!: jest.Mock;
  jest.isolateModules(() => {
    pullClient = require('../src/modules/pullClient');
    http = require('../src/modules/http');
    executePrintJob = require('../src/modules/printJob').executePrintJob;
  });
  return {
    executePrintJob,
    pullClient,
    tryFetch: http.tryFetchWithFallback as jest.MockedFunction<
      typeof http.tryFetchWithFallback
    >,
  };
};

// The backend answers a poll at once while the reported hash differs, so the
// response has to cost something or the loop would spin inside a single timer
// advance whether or not the retry pause works. 100ms stands in for the round
// trip: 30s of it is ~300 polls unpaused, ~6 paused.
const answeredPoll = (value: unknown) => () =>
  new Promise((resolve) => {
    setTimeout(() => resolve(value), 100);
  });

const withSettings = (hash: string, jobId?: string) =>
  answeredPoll({
    data: {
      jobs: jobId ? [{ data: '', jobId, printerIp: '1.2.3.4' }] : [],
      settings: { modems: [], printers: [], venueId: 'venue-1' },
      settingsHash: hash,
    },
    fetchAttempts: 1,
    viaFallback: false,
  });

// The loop has no stop switch: dropping the creds parks it on its no-creds
// wait instead of leaving a poll in flight after the test.
const parkLoop = async () => {
  psIdentity.getVenueId.mockReturnValue('');
  await jest.advanceTimersByTimeAsync(30_000);
  psIdentity.getVenueId.mockReturnValue('venue-1');
};

describe('settings retry pause', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    psIdentity.getVenueId.mockReturnValue('venue-1');
    settings.getSyncedHash.mockReturnValue('h1');
  });

  afterEach(async () => {
    await parkLoop();
    jest.useRealTimers();
  });

  it('paces the loop when the delivered settings are not acknowledged', async () => {
    // Writing settings.json failed: applyDesiredSettings resolves, but the hash
    // it was handed was never taken — which is what the loop must notice.
    const { executePrintJob, pullClient, tryFetch } = load();
    applySettings.applyDesiredSettings.mockResolvedValue({});
    tryFetch.mockImplementation(withSettings('h2', 'job-1') as any);

    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(applySettings.applyDesiredSettings).toHaveBeenCalled();
    expect(tryFetch.mock.calls.length).toBeLessThan(10);
    // The jobs in that same answer still print — the failure costs the config,
    // never the paper.
    expect(executePrintJob).toHaveBeenCalledTimes(1);
  });

  it('paces the loop when applying them throws', async () => {
    const { pullClient, tryFetch } = load();
    applySettings.applyDesiredSettings.mockRejectedValue(new Error('rejected'));
    tryFetch.mockImplementation(withSettings('h2') as any);

    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(tryFetch.mock.calls.length).toBeLessThan(10);
  });

  it('does not pace the loop once they are acknowledged', async () => {
    const { pullClient, tryFetch } = load();
    applySettings.applyDesiredSettings.mockImplementation(async () => {
      settings.getSyncedHash.mockReturnValue('h2');
    });
    tryFetch.mockImplementation(withSettings('h2') as any);

    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(tryFetch.mock.calls.length).toBeGreaterThan(20);
  });
});
