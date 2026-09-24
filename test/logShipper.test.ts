import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.mock('signale', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('../src/modules/backendUrl', () => ({
  getBackendBaseUrl: () => 'https://backend.test',
}));

const psIdentity = {
  getPrinterVersion: () => 'v-test',
  getVenueId: jest.fn(() => 'venue-1'),
  getWsSecret: jest.fn(() => 'secret'),
};
jest.mock('../src/modules/psIdentity', () => psIdentity);

jest.mock('../src/modules/http', () => ({
  __esModule: true,
  curlExecJson: jest.fn(),
  httpStatusError: jest.fn(),
  tryFetchWithFallback: jest.fn(),
  withTempJsonPayload: jest.fn(),
}));

type Shipper = typeof import('../src/modules/logShipper');
type Http = typeof import('../src/modules/http');
type Logger = typeof import('../src/modules/logger').default;

const load = () => {
  let shipper!: Shipper;
  let http!: Http;
  let logger!: Logger;
  jest.isolateModules(() => {
    shipper = require('../src/modules/logShipper');
    http = require('../src/modules/http');
    logger = require('../src/modules/logger').default;
  });
  return {
    logger,
    shipper,
    tryFetch: http.tryFetchWithFallback as jest.MockedFunction<
      typeof http.tryFetchWithFallback
    >,
  };
};

const flush = () => new Promise((r) => setImmediate(r));

// The last body handed to the transport.
const sentBody = (tryFetch: jest.Mock): any => {
  const opts = tryFetch.mock.calls.at(-1)[0];
  let body: any;
  const realFetch = global.fetch;
  global.fetch = jest.fn(async (_url: string, init: any) => {
    body = JSON.parse(init.body);
    return { json: async () => ({}), ok: true } as any;
  }) as any;
  return opts
    .fetchFn()
    .then(() => body)
    .finally(() => {
      global.fetch = realFetch;
    });
};

describe('logShipper', () => {
  let dir: string;
  let cwd: string;
  let loaded: ReturnType<typeof load>;

  beforeEach(async () => {
    jest.clearAllMocks();
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-logship-'));
    process.chdir(dir);
    psIdentity.getVenueId.mockReturnValue('venue-1');
    psIdentity.getWsSecret.mockReturnValue('secret');
    loaded = load();
  });

  afterEach(async () => {
    await loaded.shipper.resetLogShipperForTests();
    process.chdir(cwd);
    fs.rmSync(dir, { force: true, recursive: true });
    jest.restoreAllMocks();
  });

  it('ships captured lines with identity and drops them on ack', async () => {
    const { logger, shipper, tryFetch } = loaded;
    await shipper.initLogShipper();
    logger.warn('Print-job poll failing', { attempts: 3 });
    logger.error('boom');

    tryFetch.mockResolvedValueOnce({
      data: { ackSeq: 2, ok: true },
      fetchAttempts: 1,
      viaFallback: false,
    });
    const next = await shipper.shipOnce();

    const body = await sentBody(tryFetch as any);
    expect(body).toMatchObject({
      dropped: 0,
      secret: 'secret',
      venueId: 'venue-1',
      version: 'v-test',
    });
    expect(typeof body.bootId).toBe('string');
    expect(body.entries.map((e: any) => [e.seq, e.level, e.msg])).toEqual([
      [1, 'warn', 'Print-job poll failing {"attempts":3}'],
      [2, 'error', 'boom'],
    ]);
    expect(shipper.getQueueForTests()).toHaveLength(0);
    expect(next).toBe(shipper.SHIP_INTERVAL_MS);
  });

  it('keeps lines and backs off when the upload fails', async () => {
    const { logger, shipper, tryFetch } = loaded;
    await shipper.initLogShipper();
    logger.info('hello');

    tryFetch.mockRejectedValue(new Error('fetch and curl both failed'));
    expect(await shipper.shipOnce()).toBe(shipper.FAILURE_BACKOFF_MS[0]);
    expect(await shipper.shipOnce()).toBe(shipper.FAILURE_BACKOFF_MS[1]);
    expect(shipper.getQueueForTests()).toHaveLength(1);
  });

  it('backs off for long on a backend without the endpoint', async () => {
    const { logger, shipper, tryFetch } = loaded;
    await shipper.initLogShipper();
    logger.info('hello');

    const err: any = new Error('both failed');
    err.fetchFailure = { responseStatus: 404 };
    tryFetch.mockRejectedValueOnce(err);
    expect(await shipper.shipOnce()).toBe(shipper.UNSUPPORTED_BACKOFF_MS);
    expect(shipper.getQueueForTests()).toHaveLength(1);
  });

  it('never ships local-only lines or its own transport lines', async () => {
    const { logger, shipper } = loaded;
    await shipper.initLogShipper();
    logger.infoLocal('orders to print:', [{ customer: 'Jane' }]);
    logger.info('curl fallback succeeded', {
      url: 'https://backend.test/print-jobs/logs',
    });
    logger.info('kept');

    expect(shipper.getQueueForTests().map((e) => e.msg)).toEqual(['kept']);
  });

  it('truncates long lines', async () => {
    const { logger, shipper } = loaded;
    await shipper.initLogShipper();
    logger.info('x'.repeat(shipper.MAX_LINE_CHARS + 50));

    const [entry] = shipper.getQueueForTests();
    expect(entry!.msg.startsWith('x'.repeat(shipper.MAX_LINE_CHARS))).toBe(
      true
    );
    expect(entry!.msg).toContain('[truncated 50 chars]');
  });

  it('drops the oldest lines past the cap and reports how many', async () => {
    const { logger, shipper } = loaded;
    await shipper.initLogShipper();
    for (let i = 0; i < shipper.MAX_SPOOL_ENTRIES + 3; i++) {
      logger.info(`line ${i}`);
    }

    const queue = shipper.getQueueForTests();
    expect(queue).toHaveLength(shipper.MAX_SPOOL_ENTRIES);
    expect(queue[0]!.msg).toBe('line 3');
    expect(shipper.getDroppedForTests()).toBe(3);
  });

  it('restores the spool after a restart and continues its seq', async () => {
    let { logger, shipper } = loaded;
    await shipper.initLogShipper();
    logger.info('before restart 1');
    logger.info('before restart 2');
    await shipper.resetLogShipperForTests();
    await flush();

    loaded = load();
    ({ logger, shipper } = loaded);
    await shipper.initLogShipper();
    logger.info('after restart');

    expect(shipper.getQueueForTests().map((e) => [e.seq, e.msg])).toEqual([
      [1, 'before restart 1'],
      [2, 'before restart 2'],
      [3, 'after restart'],
    ]);
  });

  it('does nothing without credentials', async () => {
    const { logger, shipper, tryFetch } = loaded;
    await shipper.initLogShipper();
    logger.info('hello');
    psIdentity.getVenueId.mockReturnValue('');

    expect(await shipper.shipOnce()).toBe(shipper.SHIP_INTERVAL_MS);
    expect(tryFetch).not.toHaveBeenCalled();
  });

  describe('verbose lines', () => {
    const ack = (tryFetch: jest.Mock, ackSeq: number) =>
      tryFetch.mockResolvedValueOnce({
        data: { ackSeq, ok: true },
        fetchAttempts: 1,
        viaFallback: false,
      });
    const future = () => new Date(Date.now() + 15 * 60_000).toISOString();

    it('keeps them out of normal uploads without losing them on ack', async () => {
      const { logger, shipper, tryFetch } = loaded;
      await shipper.initLogShipper();
      logger.debug('TCP 10.0.0.5:9100 connected after 12ms');
      logger.info('Print job 1 sent');

      ack(tryFetch as any, 2);
      expect(await shipper.shipOnce()).toBe(shipper.SHIP_INTERVAL_MS);

      const body = await sentBody(tryFetch as any);
      expect(body.entries.map((e: any) => e.msg)).toEqual(['Print job 1 sent']);
      expect(shipper.getQueueForTests().map((e) => [e.seq, e.level])).toEqual([
        [1, 'debug'],
      ]);
    });

    it('ships the kept backlog once staff switch verbose on', async () => {
      const { logger, shipper, tryFetch } = loaded;
      await shipper.initLogShipper();
      logger.debug('before the call');
      shipper.setVerboseUntil(future());
      logger.debug('during the call');

      ack(tryFetch as any, 3);
      expect(await shipper.shipOnce()).toBe(shipper.VERBOSE_SHIP_INTERVAL_MS);

      const body = await sentBody(tryFetch as any);
      expect(body.entries.map((e: any) => [e.level, e.msg])).toEqual([
        ['debug', 'before the call'],
        ['info', expect.stringContaining('Verbose log shipping on')],
        ['debug', 'during the call'],
      ]);
      expect(shipper.getQueueForTests()).toHaveLength(0);
    });

    it('turns off when the poll answer stops carrying the switch', async () => {
      const { logger, shipper, tryFetch } = loaded;
      await shipper.initLogShipper();
      shipper.setVerboseUntil(future());
      shipper.setVerboseUntil(undefined);
      logger.debug('not wanted');

      ack(tryFetch as any, 99);
      expect(await shipper.shipOnce()).toBe(shipper.SHIP_INTERVAL_MS);
      const body = await sentBody(tryFetch as any);
      expect(body.entries.map((e: any) => e.level)).not.toContain('debug');
      expect(shipper.getQueueForTests().map((e) => e.msg)).toEqual([
        'not wanted',
      ]);
    });

    it('forgets them after the keep window, without counting a drop', async () => {
      const { logger, shipper } = loaded;
      await shipper.initLogShipper();
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'],
      });
      try {
        logger.debug('old detail');
        jest.setSystemTime(Date.now() + shipper.DEBUG_KEEP_MS + 1_000);
        logger.debug('fresh detail');
        await shipper.shipOnce();
      } finally {
        jest.useRealTimers();
      }

      expect(shipper.getQueueForTests().map((e) => e.msg)).toEqual([
        'fresh detail',
      ]);
      expect(shipper.getDroppedForTests()).toBe(0);
    });

    it('caps how many it keeps, oldest first', async () => {
      const { logger, shipper } = loaded;
      await shipper.initLogShipper();
      logger.info('kept info');
      for (let i = 0; i < shipper.MAX_DEBUG_ENTRIES + 2; i++) {
        logger.debug(`detail ${i}`);
      }

      const queue = shipper.getQueueForTests();
      expect(queue.filter((e) => e.level === 'debug')).toHaveLength(
        shipper.MAX_DEBUG_ENTRIES
      );
      expect(queue[0]!.msg).toBe('kept info');
      expect(queue[1]!.msg).toBe('detail 2');
      expect(shipper.getDroppedForTests()).toBe(0);
    });
  });
});
