import { isPackagedExe } from '../src/modules/installDir';

describe('isPackagedExe', () => {
  it('treats the nexe binary as the install', () => {
    expect(isPackagedExe('C:\\Quickord\\builds\\printerServer.exe')).toBe(true);
    expect(isPackagedExe('C:\\Quickord\\updater.exe')).toBe(true);
  });

  it('leaves node launches (tsx, jest, node dist/...) where they started', () => {
    expect(isPackagedExe('C:\\Program Files\\nodejs\\node.exe')).toBe(false);
    expect(isPackagedExe('C:\\Program Files\\nodejs\\NODE.EXE')).toBe(false);
    expect(isPackagedExe('/usr/local/bin/node')).toBe(false);
  });
});
