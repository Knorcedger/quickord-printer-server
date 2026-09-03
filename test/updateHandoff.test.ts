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
