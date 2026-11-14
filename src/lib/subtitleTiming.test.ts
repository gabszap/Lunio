import { describe, expect, it } from 'vitest';
import { effectiveSubtitleOffset, shiftCueWindow } from './subtitleTiming';

describe('subtitle timing matches JASSUB mediaTime + offset', () => {
  it('adds timeline origin and manual preference without clamping the origin', () => {
    expect(effectiveSubtitleOffset(120, 0.5)).toBe(120.5);
    expect(shiftCueWindow(121, 123, 120.5)).toEqual({ start: 0.5, end: 2.5 });
  });
  it.each([[1, 9, 11], [-1, 11, 13], [0, 10, 12]])('shifts by %s', (offset, start, end) => {
    expect(shiftCueWindow(10, 12, offset)).toEqual({ start, end });
  });
  it('clips a cue crossing zero and omits fully elapsed cues', () => {
    expect(shiftCueWindow(1, 3, 2)).toEqual({ start: 0, end: 1 });
    expect(shiftCueWindow(1, 2, 2)).toBeNull();
  });
});
