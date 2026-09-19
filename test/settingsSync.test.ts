import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyDesiredSettings } from '../src/modules/applySettings';
import logger from '../src/modules/logger';
import { setupPrinters } from '../src/modules/printer';
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

jest.mock('../src/modules/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
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

  it('drops the hash on a LAN push that changes something', async () => {
    await applyDesiredSettings(desired, { hash: 'abc123', source: 'test' });
    await applyDesiredSettings(
      { ...desired, printers: [{ ...desired.printers[0], copies: 2 }] },
      { source: 'LAN' }
    );

    expect(getSyncedHash()).toBeUndefined();
  });

  it('keeps the hash on a LAN push that changes nothing', async () => {
    await applyDesiredSettings(desired, { hash: 'abc123', source: 'test' });
    await applyDesiredSettings(desired, { source: 'LAN' });

    expect(getSyncedHash()).toBe('abc123');
    expect(setupPrinters).toHaveBeenCalledTimes(1);
  });

  it('clears a local field the authoritative payload omits', async () => {
    // The pull channel carries the whole desired state, so a field it leaves
    // out is unset in the database — keeping the local one would be drift the
    // acknowledged hash then reports as in sync.
    await applyDesiredSettings(
      {
        ...desired,
        printers: [{ ...desired.printers[0], priceOnOrder: false }],
      },
      { source: 'LAN' }
    );
    expect(getSettings().printers[0]?.priceOnOrder).toBe(false);

    await applyDesiredSettings(desired, {
      authoritative: true,
      hash: 'abc123',
      source: 'pull channel',
    });

    expect(getSettings().printers[0]?.priceOnOrder).toBeUndefined();
    expect(getSyncedHash()).toBe('abc123');
  });

  it('still merges a partial LAN push onto the local printer', async () => {
    await applyDesiredSettings(
      {
        ...desired,
        printers: [{ ...desired.printers[0], priceOnOrder: false }],
      },
      { source: 'LAN' }
    );
    await applyDesiredSettings(desired, { source: 'LAN' });

    expect(getSettings().printers[0]?.priceOnOrder).toBe(false);
  });

  it('does not acknowledge a hash it failed to write', async () => {
    // A directory where the file belongs: the write throws EISDIR, standing in
    // for the disk-full, permissions and file-lock cases.
    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-nowrite-'));
    fs.mkdirSync(path.join(blocked, 'settings.json'));
    process.chdir(blocked);

    try {
      await applyDesiredSettings(desired, {
        authoritative: true,
        hash: 'abc123',
        source: 'pull channel',
      });

      expect(getSyncedHash()).toBeUndefined();
    } finally {
      process.chdir(tmpDir);
    }

    // Reporting no hash is what makes the backend re-deliver, which is the
    // retry: the same payload now writes and the venue converges.
    await applyDesiredSettings(desired, {
      authoritative: true,
      hash: 'abc123',
      source: 'pull channel',
    });

    expect(getSyncedHash()).toBe('abc123');
    expect(readSettingsFile().syncedHash).toBe('abc123');
  });

  it('reports a failed write once, then says nothing while it is retried', async () => {
    // The retry runs on every poll and an unwritable settings.json never fixes
    // itself, so the caller's episode reports the first failure and silences
    // the rest — including the write error and the applied/unchanged line.
    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-nowrite-'));
    fs.mkdirSync(path.join(blocked, 'settings.json'));
    process.chdir(blocked);

    try {
      await applyDesiredSettings(desired, {
        authoritative: true,
        hash: 'abc123',
        source: 'pull channel',
      });

      // One line, carrying the real reason the write failed.
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect((logger.warn as jest.Mock).mock.calls[0][0]).toContain('EISDIR');
      expect(logger.error).not.toHaveBeenCalled();

      jest.clearAllMocks();
      await applyDesiredSettings(desired, {
        authoritative: true,
        hash: 'abc123',
        quiet: true,
        source: 'pull channel',
      });

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    } finally {
      process.chdir(tmpDir);
    }
  });

  it('does not acknowledge a LAN change it failed to write', async () => {
    await applyDesiredSettings(desired, {
      authoritative: true,
      hash: 'abc123',
      source: 'pull channel',
    });

    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-nowrite-'));
    fs.mkdirSync(path.join(blocked, 'settings.json'));
    process.chdir(blocked);
    const changed = {
      ...desired,
      printers: [{ ...desired.printers[0], copies: 2 }],
    };

    try {
      await applyDesiredSettings(changed, { source: 'LAN' });

      // The live printers now run the LAN payload, which the backend has never
      // seen. Keeping 'abc123' would report that drift as in sync.
      expect(getSyncedHash()).toBeUndefined();
    } finally {
      process.chdir(tmpDir);
    }

    // An identical push once the file is writable again is the retry: nothing
    // changes, but settings.json is still behind and has to catch up.
    await applyDesiredSettings(changed, { source: 'LAN' });

    expect(readSettingsFile().printers[0].copies).toBe(2);
  });

  it('converges after a failed write when the backend reverts meanwhile', async () => {
    await applyDesiredSettings(desired, {
      authoritative: true,
      hash: 'hash-a',
      source: 'pull channel',
    });

    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-nowrite-'));
    fs.mkdirSync(path.join(blocked, 'settings.json'));
    process.chdir(blocked);
    const changed = {
      ...desired,
      printers: [{ ...desired.printers[0], copies: 2 }],
    };

    try {
      await applyDesiredSettings(changed, {
        authoritative: true,
        hash: 'hash-b',
        source: 'pull channel',
      });

      // B is live on the printers now. Reporting 'hash-a' would let a backend
      // reverted to A see a match, stop sending, and leave B running forever.
      expect(getSettings().printers[0]?.copies).toBe(2);
      expect(getSyncedHash()).toBeUndefined();
    } finally {
      process.chdir(tmpDir);
    }

    // The revert: the backend is back on A, and an unset hash is what still
    // gets A delivered once the file is writable again.
    await applyDesiredSettings(desired, {
      authoritative: true,
      hash: 'hash-a',
      source: 'pull channel',
    });

    expect(getSettings().printers[0]?.copies).toBe(1);
    expect(getSyncedHash()).toBe('hash-a');
    expect(readSettingsFile().printers[0].copies).toBe(1);
  });

  it('accepts a printer without a networkName', async () => {
    const { networkName: _dropped, ...printer } = desired.printers[0]!;

    await applyDesiredSettings(
      { ...desired, printers: [printer] },
      { authoritative: true, hash: 'abc123', source: 'pull channel' }
    );

    expect(getSyncedHash()).toBe('abc123');
    expect(getSettings().printers[0]?.networkName).toBe('');
  });

  it('accepts a printer whose fields are explicitly null', async () => {
    // A field cleared in the database arrives as null, which the schema rejects
    // outright — one such printer would fail the parse for the whole venue and
    // leave every printer and modem setting stale until someone re-saved it.
    await applyDesiredSettings(
      {
        ...desired,
        printers: [
          {
            ...desired.printers[0],
            ip: null,
            networkName: null,
            priceOnOrder: null,
          },
        ],
      },
      { authoritative: true, hash: 'abc123', source: 'pull channel' }
    );

    expect(getSyncedHash()).toBe('abc123');
    expect(getSettings().printers[0]?.networkName).toBe('');
    expect(getSettings().printers[0]?.ip).toBe('');
    expect(getSettings().printers[0]?.priceOnOrder).toBeUndefined();
  });

  it('treats null as a clear on a partial push, not as "keep the local value"', async () => {
    await applyDesiredSettings(desired, { source: 'LAN' });
    expect(getSettings().printers[0]?.networkName).toBe('kitchen');

    // undefined means "not sent"; null means the field was cleared, so it must
    // fall back to the schema default rather than inherit what is local.
    await applyDesiredSettings(
      { ...desired, printers: [{ ...desired.printers[0], networkName: null }] },
      { source: 'LAN' }
    );

    expect(getSettings().printers[0]?.networkName).toBe('');
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
