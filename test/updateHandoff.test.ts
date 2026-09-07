import type * as AutoUpdate from '../src/autoupdate/autoupdate';
import type { UpdateCheckResult } from '../src/autoupdate/autoupdate';

// The point of these: the updater child stops this service as its first act, so
// the on-demand update's result has to be reported *before* the handoff. If the
// callback stops being forwarded or awaited, the report goes back to racing the
// process that kills it.
const UPDATING: UpdateCheckResult = {
  currentVersion: '1',
  latestVersion: '2',
  state: 'updating',
};

// A started update latches updateInFlight for the life of the process, so each
// test needs its own copy of the module.
function loadAutoUpdate(): typeof AutoUpdate {
  let mod: typeof AutoUpdate;
  jest.isolateModules(() => {
    // eslint-disable-next-line global-require
    mod = require('../src/autoupdate/autoupdate');
  });
  return mod!;
}

describe('triggerUpdate handoff', () => {
  it('awaits beforeHandoff before the updater is spawned', async () => {
    const { setUpdateHandler, triggerUpdate } = loadAutoUpdate();
    const order: string[] = [];
    setUpdateHandler(async (beforeHandoff) => {
      // Stands in for downloadLatestCode: report, then spawn the child.
      await beforeHandoff?.(UPDATING);
      order.push('spawn');
      return UPDATING;
    });

    const result = await triggerUpdate(async () => {
      await new Promise((res) => {
        setTimeout(res, 20);
      });
      order.push('report');
    });

    expect(order).toEqual(['report', 'spawn']);
    expect(result).toEqual(UPDATING);
  });

  it('reuses an in-flight update instead of spawning a second updater', async () => {
    const { setUpdateHandler, triggerUpdate } = loadAutoUpdate();
    let runs = 0;
    setUpdateHandler(async (beforeHandoff) => {
      runs += 1;
      await beforeHandoff?.(UPDATING);
      return UPDATING;
    });

    const [first, second] = await Promise.all([
      triggerUpdate(async () => {}),
      triggerUpdate(async () => {}),
    ]);

    expect(runs).toBe(1);
    expect(first).toEqual(UPDATING);
    expect(second).toEqual(UPDATING);
  });

  it('stays retriable when there was nothing to update', async () => {
    const { setUpdateHandler, triggerUpdate } = loadAutoUpdate();
    let runs = 0;
    const latest: UpdateCheckResult = {
      currentVersion: '2',
      latestVersion: '2',
      state: 'already-latest',
    };
    setUpdateHandler(async () => {
      runs += 1;
      return latest;
    });

    await triggerUpdate();
    await triggerUpdate();

    expect(runs).toBe(2);
  });
});

describe('sc.exe error codes', () => {
  it('prefers the exit code, which is the Win32 error itself', () => {
    const { scErrorCode } = loadAutoUpdate();
    expect(scErrorCode(1060, 'anything')).toBe(1060);
    expect(scErrorCode(5, '')).toBe(5);
  });

  it('falls back to the printed code when the exit code is lost', () => {
    const { scErrorCode } = loadAutoUpdate();
    expect(
      scErrorCode(0, '[SC] StartService FAILED 1056:\n\nAn instance...')
    ).toBe(1056);
    expect(scErrorCode(0, 'OpenService FAILED 5:')).toBe(5);
    expect(scErrorCode(0, 'no code here')).toBeNull();
  });

  it('explains the codes a technician will actually hit', () => {
    const { describeScError } = loadAutoUpdate();
    expect(describeScError(5, '[SC] OpenService FAILED 5:')).toContain(
      'not running as administrator'
    );
    // A localized message with no known code is passed through untouched.
    expect(describeScError(0, ' Η υπηρεσία δεν είναι εγκατεστημένη ')).toBe(
      'Η υπηρεσία δεν είναι εγκατεστημένη'
    );
  });
});
