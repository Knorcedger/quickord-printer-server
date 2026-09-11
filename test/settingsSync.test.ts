import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyDesiredSettings } from '../src/modules/applySettings';
import {
  getSettings,
  getSyncedHash,
  loadSettings,
  Settings,
  updateSettings,
} from '../src/modules/settings';

jest.mock('../src/modules/api', () => ({
  apiCall: jest.fn().mockResolvedValue({ data: {} }),
  registerPrinterServerIp: jest.fn(),
  startPrinterServerIpRegistration: jest.fn(),
}));

jest.mock('../src/modules/printer', () => ({
  setupPrinters: jest.fn(),
}));

jest.mock('../src/modules/modem', () => ({
  getModems: jest.requireActual('../src/modules/modem').getModems,
  syncModems: jest.fn(),
}));

const cwd = process.cwd();
let tmpDir: string;

const readSettingsFile = () =>
  JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));

const desired = {
  modems: [],
  printers: [
    { characterSet: 'WPC1253_GREEK', networkName: 'kitchen', port: 'COM5' },
  ],
  venueId: 'venue-1',
};

describe('settings hash sync', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-sync-'));
    process.chdir(tmpDir);
  });

  afterAll(() => process.chdir(cwd));

  beforeEach(() => {
    jest.clearAllMocks();
    updateSettings(Settings.parse({ printers: [] }));
  });

  it('stores the hash the pull channel sent, verbatim', async () => {
    await applyDesiredSettings(desired, { hash: 'abc123', source: 'test' });

    expect(getSyncedHash()).toBe('abc123');
    expect(readSettingsFile().syncedHash).toBe('abc123');
  });

  it('drops the hash on a LAN push, so the backend re-delivers', async () => {
    await applyDesiredSettings(desired, { hash: 'abc123', source: 'test' });
    await applyDesiredSettings(desired, { source: 'LAN' });

    expect(getSyncedHash()).toBeUndefined();
  });

  it('keeps the hash across a reload of the file it wrote', async () => {
    await applyDesiredSettings(desired, { hash: 'abc123', source: 'test' });
    updateSettings(Settings.parse({ printers: [] }));

    await loadSettings();

    expect(getSyncedHash()).toBe('abc123');
  });

  it('drops the hash when settings.json was edited by hand', async () => {
    await applyDesiredSettings(desired, { hash: 'abc123', source: 'test' });

    const onDisk = readSettingsFile();
    onDisk.printers[0].copies = 3;
    fs.writeFileSync(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify(onDisk, null, 2)
    );

    await loadSettings();

    expect(getSyncedHash()).toBeUndefined();
    expect(getSettings().printers[0]?.copies).toBe(3);
  });
});
