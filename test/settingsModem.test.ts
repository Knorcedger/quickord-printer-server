import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Request, Response } from 'express';

import { syncModems } from '../src/modules/modem';
import {
  getModems,
  getPublicSettings,
  getSettings,
  Settings,
  updateSettings,
} from '../src/modules/settings';
import settingsResolver from '../src/resolvers/settings';

import { dropAllFakePorts, instanceFor, useFakePorts } from './helpers/fakeModem';

jest.mock('../src/modules/api', () => ({
  apiCall: jest.fn().mockResolvedValue({ data: {} }),
  registerPrinterServerIp: jest.fn(),
}));

jest.mock('../src/modules/printer', () => ({
  setupPrinters: jest.fn(),
}));

const cwd = process.cwd();
let tmpDir: string;

const post = async (body: Record<string, unknown>) => {
  const res = {
    send: jest.fn(),
    status: jest.fn().mockReturnThis(),
  };
  await settingsResolver({ body } as Request, res as unknown as Response);
  return res;
};

const readSettingsFile = () =>
  JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));

describe('settings resolver — modems', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-settings-'));
    process.chdir(tmpDir);
  });

  afterAll(() => process.chdir(cwd));

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.clearAllMocks();
    updateSettings(Settings.parse({ printers: [] }));
    useFakePorts('COM3', 'COM4');
  });

  afterEach(async () => {
    await syncModems([]);
    dropAllFakePorts();
    jest.useRealTimers();
  });

  describe('getModems normalizer', () => {
    it('migrates a legacy single modem', () => {
      const parsed = Settings.parse({
        modem: { port: 'COM3', venueId: 'venue-1' },
        printers: [],
      });
      expect(getModems(parsed)).toEqual([{ port: 'COM3', venueId: 'venue-1' }]);
    });

    it('prefers modems[] when both are present', () => {
      const parsed = Settings.parse({
        modem: { port: 'COM3' },
        modems: [{ port: 'COM4' }],
        printers: [],
      });
      expect(getModems(parsed).map((m) => m.port)).toEqual(['COM4']);
    });

    it('drops entries without a port', () => {
      const parsed = Settings.parse({
        modems: [{ port: '' }, { port: 'COM3' }],
        printers: [],
      });
      expect(getModems(parsed).map((m) => m.port)).toEqual(['COM3']);
    });
  });

  it('opens the modem of a legacy payload', async () => {
    await post({
      modem: { port: 'COM3', venueId: 'venue-1' },
      printers: [],
      venueId: 'venue-1',
    });

    expect(instanceFor('COM3')?.serial?.isOpen).toBe(true);
    expect(getModems().map((m) => m.port)).toEqual(['COM3']);
  });

  it('opens both modems and writes canonical + legacy mirror', async () => {
    await post({
      modems: [
        { label: 'Κύρια', port: 'COM3' },
        { label: 'Δευτερεύουσα', port: 'COM4' },
      ],
      printers: [],
      venueId: 'venue-1',
    });

    expect(instanceFor('COM3')?.serial?.isOpen).toBe(true);
    expect(instanceFor('COM4')?.serial?.isOpen).toBe(true);

    const onDisk = readSettingsFile();
    expect(onDisk.modems.map((m: { port: string }) => m.port)).toEqual([
      'COM3',
      'COM4',
    ]);
    expect(onDisk.modem.port).toBe('COM3');
  });

  it('closes every modem when the list is emptied', async () => {
    await post({ modems: [{ port: 'COM3' }], printers: [], venueId: 'venue-1' });
    expect(instanceFor('COM3')?.serial?.isOpen).toBe(true);

    await post({ modems: [], printers: [], venueId: 'venue-1' });

    expect(instanceFor('COM3')).toBeUndefined();
    expect(getSettings().modem).toBeUndefined();
  });

  it('keeps saving settings when a modem entry has no port', async () => {
    const res = await post({
      modems: [{ port: '' }],
      printers: [],
      venueId: 'venue-1',
    });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(getSettings().venueId).toBe('venue-1');
  });

  it('keeps the venue identity that only exists in the legacy modem', async () => {
    updateSettings(
      Settings.parse({
        modem: { port: 'COM3', venueId: 'venue-1' },
        printers: [],
      })
    );

    const rejected = await post({
      modems: [{ port: 'COM3' }],
      printers: [],
      venueId: 'other-venue',
    });
    expect(rejected.status).toHaveBeenCalledWith(403);

    const accepted = await post({
      modems: [{ port: 'COM3' }],
      printers: [],
      venueId: 'venue-1',
    });
    expect(accepted.status).toHaveBeenCalledWith(200);
    expect(getSettings().venueId).toBe('venue-1');
  });

  it('never exposes wsSecret with the new schema', async () => {
    const res = await post({
      modems: [{ port: 'COM3' }],
      printers: [],
      venueId: 'venue-1',
      wsSecret: 'super-secret',
    });

    expect(getSettings().wsSecret).toBe('super-secret');
    expect(getPublicSettings()).not.toHaveProperty('wsSecret');
    expect(JSON.stringify(res.send.mock.calls)).not.toContain('super-secret');
  });
});
