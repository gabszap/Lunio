import { describe, expect, it } from 'vitest';
import { avcCodecFor, codecFromAnnexB } from './h264';

describe('avcCodecFor', () => {
  it.each([
    [1280, 720, 30, 'avc1.64001f'],
    [1280, 720, 60, 'avc1.640020'],
    [1920, 1080, 30, 'avc1.640028'],
    [1920, 1080, 60, 'avc1.64002a'],
    [3840, 2160, 30, 'avc1.640033'],
    [3840, 2160, 60, 'avc1.640034'],
  ])('%ix%i at %i fps -> %s', (w, h, fps, codec) => {
    expect(avcCodecFor(w, h, fps)).toBe(codec);
  });

  it('falls back to the highest level for anything bigger', () => {
    expect(avcCodecFor(7680, 4320, 120)).toBe('avc1.640034');
  });
});

describe('codecFromAnnexB', () => {
  it('reads profile, constraints and level from an SPS after a 4-byte start code', () => {
    expect(codecFromAnnexB(new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0xac, 0xd9]))).toBe('avc1.64002a');
  });

  it('accepts a 3-byte start code', () => {
    expect(codecFromAnnexB(new Uint8Array([0, 0, 1, 0x67, 0x4d, 0x40, 0x1f, 0x00]))).toBe('avc1.4d401f');
  });

  it('skips an AUD/other NAL before the SPS', () => {
    expect(codecFromAnnexB(new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0x00, 0x00]))).toBe('avc1.640028');
  });

  it('returns null with no SPS, an empty buffer or an SPS past byte 200', () => {
    expect(codecFromAnnexB(new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3, 4, 5, 6, 7]))).toBeNull();
    expect(codecFromAnnexB(new Uint8Array())).toBeNull();
    const late = new Uint8Array(260);
    late.set([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0, 0], 220);
    expect(codecFromAnnexB(late)).toBeNull();
  });
});
