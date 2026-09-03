import { FailureEpisode } from '../src/modules/failureEpisode';
import logger from '../src/modules/logger';

jest.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

const mockedLogger = logger as jest.Mocked<typeof logger>;

describe('FailureEpisode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.setSystemTime(new Date('2026-09-03T10:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('logs the first failure in full and then stays quiet', () => {
    const episode = new FailureEpisode('Print-job poll');
    const err = new Error('boom');

    episode.fail(err);
    expect(mockedLogger.error).toHaveBeenCalledWith(
      'Print-job poll failed:',
      err
    );

    for (let i = 0; i < 50; i++) {
      jest.advanceTimersByTime(3_000);
      episode.fail(err);
    }
    expect(mockedLogger.error).toHaveBeenCalledTimes(1);
    expect(episode.active).toBe(true);
    expect(episode.failureCount).toBe(51);
  });

  it('summarises once per interval while the episode lasts', () => {
    const episode = new FailureEpisode('Print-job poll');

    episode.fail(new Error('boom'));
    jest.advanceTimersByTime(5 * 60_000);
    episode.fail(new Error('still down'));

    expect(mockedLogger.error).toHaveBeenLastCalledWith(
      'Print-job poll still failing — 2 consecutive failures over 5m. Last error: still down'
    );

    jest.advanceTimersByTime(60_000);
    episode.fail(new Error('still down'));
    expect(mockedLogger.error).toHaveBeenCalledTimes(2);
  });

  it('logs one recovery line carrying the count and duration', () => {
    const episode = new FailureEpisode('Print-job poll');

    episode.fail(new Error('boom'));
    jest.advanceTimersByTime(9 * 60_000);
    episode.fail(new Error('boom'));
    episode.succeed();

    expect(mockedLogger.info).toHaveBeenCalledWith(
      'Print-job poll recovered after 2 failures over 9m'
    );
    expect(episode.active).toBe(false);

    // A success with no episode in progress is silent.
    episode.succeed();
    expect(mockedLogger.info).toHaveBeenCalledTimes(1);
  });

  it('reset drops the streak without claiming a recovery', () => {
    const episode = new FailureEpisode('Print-job poll');

    episode.fail(new Error('boom'));
    episode.reset();

    expect(episode.active).toBe(false);
    expect(mockedLogger.info).not.toHaveBeenCalled();
  });
});
