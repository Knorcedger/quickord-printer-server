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
type Logger = typeof import('../src/modules/logger').default;

const load = () => {
  let pullClient!: typeof import('../src/modules/pullClient');
  let http!: Http;
  let logger!: Logger;
  jest.isolateModules(() => {
    pullClient = require('../src/modules/pullClient');
    http = require('../src/modules/http');
    logger = require('../src/modules/logger').default;
  });
  return {
    logger: logger as jest.Mocked<Logger>,
    pullClient,
    tryFetch: http.tryFetchWithFallback as jest.MockedFunction<
      typeof http.tryFetchWithFallback
    >,
  };
};

// A successful poll re-polls immediately, so an instantly-resolving mock would
// spin the loop forever under fake timers. Mirror the backend's idle hold.
const heldPoll = (value: unknown) => () =>
  new Promise((resolve) => {
    setTimeout(() => resolve(value), 25_000);
  });

// The loop has no stop switch: dropping the creds parks it on its no-creds
// wait instead of leaving a poll in flight after the test.
const parkLoop = async () => {
  psIdentity.getVenueId.mockReturnValue('');
  await jest.advanceTimersByTimeAsync(30_000);
  psIdentity.getVenueId.mockReturnValue('venue-1');
};

describe('pull loop failure logging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.setSystemTime(new Date('2026-09-03T10:00:00Z'));
    psIdentity.getVenueId.mockReturnValue('venue-1');
  });

  afterEach(async () => {
    await parkLoop();
    jest.useRealTimers();
  });

  it('logs the first poll failure in full, then one summary per 5 minutes', async () => {
    const { logger, pullClient, tryFetch } = load();
    tryFetch.mockRejectedValue(new Error('fetch and curl both failed'));

    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(6 * 60_000);

    expect(tryFetch.mock.calls.length).toBeGreaterThan(50);
    // Only the first poll of the episode lets the http layer dump the failure.
    expect(
      tryFetch.mock.calls.filter(
        (call) => !(call[0] as any).suppressFailureLogs
      )
    ).toHaveLength(1);
    expect(logger.error).toHaveBeenNthCalledWith(
      1,
      'Print-job poll failed:',
      expect.any(Error)
    );
    expect(logger.error.mock.calls.length).toBeLessThanOrEqual(2);
    expect(logger.error.mock.calls[1]?.[0]).toMatch(
      /^Print-job poll still failing — \d+ consecutive failures over \d+m/
    );
  });

  it('logs one recovery line and re-arms the full dump', async () => {
    const { logger, pullClient, tryFetch } = load();
    tryFetch.mockRejectedValue(new Error('fetch and curl both failed'));

    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(60_000);
    tryFetch.mockImplementation(
      heldPoll({
        data: { jobs: [] },
        fetchAttempts: 1,
        viaFallback: false,
      }) as any
    );
    await jest.advanceTimersByTimeAsync(30_000);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Print-job poll recovered after \d+ failures over \d+m$/
      )
    );

    const callsBefore = tryFetch.mock.calls.length;
    tryFetch.mockRejectedValue(new Error('fetch and curl both failed'));
    await jest.advanceTimersByTimeAsync(30_000);
    expect(
      tryFetch.mock.calls
        .slice(callsBefore)
        .filter((call) => !(call[0] as any).suppressFailureLogs).length
    ).toBeGreaterThan(0);
  });

  it('does not let an auth rejection inflate the next outage count', async () => {
    const { logger, pullClient, tryFetch } = load();
    tryFetch.mockResolvedValue({
      data: {
        code: 'printJobs.authRejected',
        error: 'invalid venue credentials',
      },
      fetchAttempts: 1,
      viaFallback: false,
    } as any);

    pullClient.initPullClient();
    await jest.advanceTimersByTimeAsync(3 * 60_000);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).toMatch(/^Print-job poll rejected/);

    tryFetch.mockRejectedValue(new Error('fetch and curl both failed'));
    await jest.advanceTimersByTimeAsync(65_000);

    // A fresh episode: full dump again, counted from one.
    expect(logger.error).toHaveBeenNthCalledWith(
      2,
      'Print-job poll failed:',
      expect.any(Error)
    );
  });
});
