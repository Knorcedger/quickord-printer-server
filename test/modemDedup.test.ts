import { __resetDedup, shouldEmit } from '../src/modules/modemDedup';

describe('modemDedup.shouldEmit', () => {
  beforeEach(() => __resetDedup());

  it('lets the first sighting through', () => {
    expect(shouldEmit('6976641604', 1_000)).toBe(true);
  });

  it('suppresses the same number inside the window', () => {
    expect(shouldEmit('6976641604', 1_000)).toBe(true);
    expect(shouldEmit('6976641604', 3_000)).toBe(false);
  });

  it('lets the same number through after the window', () => {
    expect(shouldEmit('6976641604', 1_000)).toBe(true);
    expect(shouldEmit('6976641604', 5_999)).toBe(false);
    expect(shouldEmit('6976641604', 6_001)).toBe(true);
  });

  it('treats different formats of the same number as one call', () => {
    expect(shouldEmit('+306976641604', 1_000)).toBe(true);
    expect(shouldEmit('6976641604', 1_500)).toBe(false);
  });

  it('does not suppress different numbers', () => {
    expect(shouldEmit('2101111111', 1_000)).toBe(true);
    expect(shouldEmit('2102222222', 1_000)).toBe(true);
  });
});
