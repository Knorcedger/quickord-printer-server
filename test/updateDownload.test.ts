import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as AutoUpdate from '../src/autoupdate/autoupdate';

vi.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/modules/api', () => ({
  reportFetchFailure: vi.fn(() => Promise.resolve()),
}));

const curlExec = vi.fn();
vi.mock('../src/modules/http', async () => ({
  ...(await vi.importActual('../src/modules/http')),
  curlExec: (...a: unknown[]) => curlExec(...a),
}));

const VERSION_URL = 'https://example.test/releases/latest';
const UPDATE_URL = 'https://example.test/release.zip';

// A release download that answers 404 falls back to curl. Without --fail curl
// exits 0 on the error page, which then fails at unzip as UPDATE_FAILED.
describe('release download over the curl fallback', () => {
  const cwd = process.cwd();
  const realFetch = global.fetch;
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-download-'));
    fs.writeFileSync(path.join(root, 'version'), 'v2026.01.01-000001');
    process.chdir(root);
    process.env.CODE_VERSION_URL = VERSION_URL;
    process.env.CODE_UPDATE_URL = UPDATE_URL;
    global.fetch = vi.fn(async (url: any) =>
      url === VERSION_URL
        ? ({
            ok: true,
            json: async () => ({ tag_name: 'v2099.01.01-000001' }),
          } as any)
        : ({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            body: null,
          } as any)
    ) as any;
    curlExec.mockReset();
  });

  afterEach(() => {
    process.chdir(cwd);
    global.fetch = realFetch;
    delete process.env.CODE_VERSION_URL;
    delete process.env.CODE_UPDATE_URL;
    fs.rmSync(root, { force: true, recursive: true });
  });

  async function loadAutoUpdate(): Promise<typeof AutoUpdate> {
    let mod: typeof AutoUpdate;
    vi.resetModules();
    mod = await import('../src/autoupdate/autoupdate');
    return mod!;
  }

  it('asks curl to fail on an HTTP error and codes it DOWNLOAD_FAILED', async () => {
    curlExec.mockRejectedValue(
      Object.assign(
        new Error('curl: (22) The requested URL returned error: 404'),
        {
          code: 22,
        }
      )
    );
    const { setUpdateHandler, triggerUpdate, downloadLatestCode } =
      await loadAutoUpdate();
    setUpdateHandler((beforeHandoff) => downloadLatestCode(0, beforeHandoff));

    const result = await triggerUpdate();

    expect(curlExec).toHaveBeenCalledWith(expect.stringContaining('--fail'));
    expect(result).toMatchObject({
      errorCode: 'DOWNLOAD_FAILED',
      state: 'failed',
    });
  });

  // A stalled connection once hung a venue's boot for 13h.
  it('caps the version check and the download in time', async () => {
    curlExec.mockRejectedValue(new Error('curl failed'));
    const { setUpdateHandler, triggerUpdate, downloadLatestCode } =
      await loadAutoUpdate();
    setUpdateHandler((beforeHandoff) => downloadLatestCode(0, beforeHandoff));

    await triggerUpdate();

    for (const [, init] of (global.fetch as Mock).mock.calls) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(curlExec).toHaveBeenCalledWith(
      expect.stringMatching(/--connect-timeout \d+ --max-time \d+/)
    );
  });

  it('lets only the boot-time check respect the failed-release cap', async () => {
    const { setUpdateHandler, triggerUpdate } = await loadAutoUpdate();
    const handler = vi.fn(
      async (_beforeHandoff?: unknown, _force?: boolean) => ({
        state: 'already-latest' as const,
      })
    );
    setUpdateHandler(handler);

    await triggerUpdate();
    await triggerUpdate(undefined, false);

    expect(handler.mock.calls.map((c) => c[1])).toEqual([true, false]);
  });
});
