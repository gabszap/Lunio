import { describe, expect, it } from 'vitest';
import { CaptureClock, FrameDecimator } from './timing';

describe('CaptureClock', () => {
  it('starts with the first offset', () => {
    expect(new CaptureClock().stamp(1000, 5000)).toBe(5000);
  });

  it('a late batched read does not push the offset up by more than 0.02 ms', () => {
    const c = new CaptureClock();
    c.stamp(1000, 5000); // offset 4000
    expect(c.stamp(1033, 5300)).toBeCloseTo(1033 + 4000.02, 5);
  });

  it('an earlier arrival lowers the offset at once', () => {
    const c = new CaptureClock();
    c.stamp(1000, 5000);
    expect(c.stamp(1066, 5000)).toBe(1066 + 3934);
  });

  it('stamps never go backwards once the offset sits at its minimum, even with jittery reads', () => {
    const c = new CaptureClock();
    let prev = -Infinity;
    let seed = 7;
    for (let i = 0; i < 100; i++) {
      seed = (seed * 16807) % 2147483647;
      const noise = i === 0 ? 0 : (seed % 31); // 0..30 ms of read delay on top of the minimum
      const cap = i * (1000 / 60);
      const s = c.stamp(cap, 10_000 + cap + noise);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });

  it('peek applies the current offset without moving it', () => {
    const c = new CaptureClock();
    expect(c.peek(1000)).toBeNull();
    c.stamp(1000, 5000);
    expect(c.peek(2000)).toBe(6000);
    expect(c.peek(2000)).toBe(6000);
  });

  it('reset forgets the offset', () => {
    const c = new CaptureClock();
    c.stamp(1000, 5000);
    c.reset();
    expect(c.stamp(1000, 9000)).toBe(9000);
  });
});

describe('FrameDecimator', () => {
  const feed = (d: FrameDecimator, inFps: number, n: number) =>
    Array.from({ length: n }, (_, i) => i).filter((i) => d.shouldEncode((i * 1000) / inFps));

  it('60 fps in, 30 out: every other frame', () => {
    expect(feed(new FrameDecimator(30), 60, 7)).toEqual([0, 2, 4, 6]);
  });

  it('60 in, 60 out keeps all; 24 in, 30 out keeps all', () => {
    expect(feed(new FrameDecimator(60), 60, 10)).toHaveLength(10);
    expect(feed(new FrameDecimator(30), 24, 10)).toHaveLength(10);
  });

  it('reset reopens the gate', () => {
    const d = new FrameDecimator(30);
    expect(d.shouldEncode(0)).toBe(true);
    expect(d.shouldEncode(10)).toBe(false);
    d.reset();
    expect(d.shouldEncode(10)).toBe(true);
  });
});
