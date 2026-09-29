import { watchdogRelaunchCommand } from '../src/autoupdate/autoupdate';

// What the restart watchdog runs when the service will not come up.
describe('watchdogRelaunchCommand', () => {
  const exe = 'C:\\Quickord\\builds\\printerServer.exe';
  const node = 'C:\\Program Files\\nodejs\\node.exe';

  it('starts the exe bare, so a restart is a boot with a version check', () => {
    expect(watchdogRelaunchCommand(exe, [exe, exe], [])).toBe(`"${exe}"`);
  });

  it('never carries the update chain args over', () => {
    expect(
      watchdogRelaunchCommand(
        exe,
        [exe, exe, '--remove', 'C:\\tmp\\code', '--parent', 'C:\\Quickord'],
        []
      )
    ).toBe(`"${exe}"`);
  });

  it('keeps --noupdate, or a suppressed install re-enters the update loop', () => {
    expect(watchdogRelaunchCommand(exe, [exe, exe, '--noupdate'], [])).toBe(
      `"${exe}" "--noupdate"`
    );
  });

  it('gives a node launch its entry point back', () => {
    expect(
      watchdogRelaunchCommand(
        node,
        [node, 'C:\\Quickord\\dist\\index.js', '--noupdate'],
        ['--max-old-space-size=256']
      )
    ).toBe(
      `"${node}" "--max-old-space-size=256" "C:\\Quickord\\dist\\index.js" "--noupdate"`
    );
  });
});
