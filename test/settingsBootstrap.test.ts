import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyBootstrapIdentity,
  applyDesiredSettings,
  VenueMismatchError,
} from '../src/modules/applySettings';
import { setupPrinters } from '../src/modules/printer';
import {
  getSettings,
  getSyncedHash,
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

jest.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.mock('../src/modules/modem', () => ({
  getModems: jest.requireActual('../src/modules/modem').getModems,
  syncModems: jest.fn(),
}));

const cwd = process.cwd();
let tmpDir: string;

const readSettingsFile = () =>
  JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));

const pulled = {
  modems: [],
  printers: [
    { characterSet: 'WPC1253_GREEK', networkName: 'kitchen', port: 'COM5' },
  ],
  venueId: 'venue-1',
};

describe('LAN bootstrap identity', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bootstrap-'));
    process.chdir(tmpDir);
  });

  afterAll(() => process.chdir(cwd));

  beforeEach(() => {
    jest.clearAllMocks();
    updateSettings(Settings.parse({ printers: [] }));
  });

  it('claims a PS with no venue and stores the secret', async () => {
    const result = await applyBootstrapIdentity({
      venueId: 'venue-1',
      wsSecret: 's1',
    });

    expect(result).toEqual({ isFirstClaim: true, venueId: 'venue-1' });
    expect(getSettings().venueId).toBe('venue-1');
    expect(getSettings().wsSecret).toBe('s1');
    expect(readSettingsFile().wsSecret).toBe('s1');
  });

  it('rejects a push from another venue', async () => {
    await applyBootstrapIdentity({ venueId: 'venue-1', wsSecret: 's1' });

    await expect(
      applyBootstrapIdentity({ venueId: 'venue-2', wsSecret: 's2' })
    ).rejects.toBeInstanceOf(VenueMismatchError);
    expect(getSettings().wsSecret).toBe('s1');
  });

  it('rejects a push without a venueId', async () => {
    await expect(applyBootstrapIdentity({ wsSecret: 's1' })).rejects.toThrow(
      'venueId is required'
    );
    expect(getSettings().venueId).toBeUndefined();
  });

  it('keeps the secret on disk when the push carries none', async () => {
    await applyBootstrapIdentity({ venueId: 'venue-1', wsSecret: 's1' });
    const result = await applyBootstrapIdentity({ venueId: 'venue-1' });

    expect(result.isFirstClaim).toBe(false);
    expect(getSettings().wsSecret).toBe('s1');
  });

  it('ignores printers and modems from an old FE full-state push', async () => {
    await applyDesiredSettings(pulled, { hash: 'h1', source: 'pull' });
    jest.clearAllMocks();

    await applyBootstrapIdentity({
      modems: [{ modemId: 'm1', port: 'COM9' }],
      printers: [{ networkName: 'bar', port: 'COM7' }],
      venueId: 'venue-1',
      wsSecret: 's1',
    } as never);

    expect(getSettings().printers.map((p) => p.networkName)).toEqual([
      'kitchen',
    ]);
    expect(getSettings().modems).toEqual([]);
    expect(getSettings().wsSecret).toBe('s1');
    // Identity only: the pulled settings stay acknowledged, nothing is rebuilt.
    expect(getSyncedHash()).toBe('h1');
    expect(setupPrinters).not.toHaveBeenCalled();
  });
});
