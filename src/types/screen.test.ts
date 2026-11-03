import { describe, expect, it } from 'vitest';
import { DEFAULT_SCREEN_QUALITY, SCREEN_QUALITIES, screenQuality } from './screen';

describe('screenQuality', () => {
  it('resolves 1080p60 to its capture size, fps and bitrate', () => {
    expect(screenQuality('1080p60')).toMatchObject({ width: 1920, height: 1080, fps: 60, maxBitrate: 10_000_000 });
  });

  it('carries the bitrate ceiling of the lowest and highest qualities', () => {
    expect(screenQuality('2160p60')?.maxBitrate).toBe(45_000_000);
    expect(screenQuality('720p30')?.maxBitrate).toBe(2_700_000);
  });

  it('returns null for anything outside the table', () => {
    expect(screenQuality('1440p60')).toBeNull();
    expect(screenQuality(undefined)).toBeNull();
    expect(screenQuality({})).toBeNull();
    expect(screenQuality('__proto__')).toBeNull();
  });
});

describe('SCREEN_QUALITIES', () => {
  it('lists the six qualities in order', () => {
    expect(SCREEN_QUALITIES.map((q) => q.id)).toEqual(['720p30', '720p60', '1080p30', '1080p60', '2160p30', '2160p60']);
  });

  it('defaults to a quality that is in the table', () => {
    expect(DEFAULT_SCREEN_QUALITY).toBe('1080p60');
    expect(SCREEN_QUALITIES.some((q) => q.id === DEFAULT_SCREEN_QUALITY)).toBe(true);
  });
});
