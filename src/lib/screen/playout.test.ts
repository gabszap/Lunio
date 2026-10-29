import { describe, expect, it } from 'vitest';
import { AudioPlayout, VideoOnlyClock, VideoPlayout, type EncodedVideo } from './playout';

describe('AudioPlayout', () => {
  it('starts one target ahead of the context clock and chains the next blocks', () => {
    const p = new AudioPlayout();
    const first = p.schedule(10, 0.02, 5000);
    expect(first.startAt).toBeCloseTo(10.12, 6);
    expect(first.underrun).toBe(false);
    expect(p.schedule(10.01, 0.02, 5020).startAt).toBeCloseTo(10.14, 6);
  });

  it('an underrun grows the target by 1.4x up to 0.9 s and counts', () => {
    const p = new AudioPlayout();
    p.schedule(10, 0.02, 0);
    const late = p.schedule(10.5, 0.02, 20);
    expect(late.underrun).toBe(true);
    expect(p.underruns).toBe(1);
    expect(p.targetS).toBeCloseTo(0.168, 6);
    for (let i = 0; i < 20; i++) p.schedule(20 + i, 0.02, 0);
    expect(p.targetS).toBeLessThanOrEqual(0.9);
  });

  it('trims a buffer that grew past target + 250 ms', () => {
    const p = new AudioPlayout();
    let worst = 0;
    for (let i = 0; i < 100; i++) worst = Math.max(worst, p.schedule(10, 0.02, i * 20).startAt - 10);
    expect(worst).toBeLessThanOrEqual(0.12 + 0.25 + 0.02 + 1e-9);
  });

  it('relax lowers the target 5% at a time and never below the base', () => {
    const p = new AudioPlayout();
    p.schedule(10, 0.02, 0);
    p.schedule(11, 0.02, 0); // underrun -> 0.168
    p.relax();
    expect(p.targetS).toBeCloseTo(0.168 * 0.95, 6);
    for (let i = 0; i < 100; i++) p.relax();
    expect(p.targetS).toBeCloseTo(0.12, 6);
  });

  it('media time follows the last scheduled block and is null before the first one', () => {
    const p = new AudioPlayout();
    expect(p.mediaTimeMs(5, 0)).toBeNull();
    const { startAt } = p.schedule(10, 0.02, 5000);
    expect(p.mediaTimeMs(startAt, 0)).toBeCloseTo(5000, 3);
    expect(p.mediaTimeMs(startAt + 1, 0.05)).toBeCloseTo(5950, 3);
  });

  it('keeps a queue of stamps and falls back when it is empty', () => {
    const p = new AudioPlayout();
    expect(p.shiftStamp(9)).toBe(9);
    p.pushStamp(1);
    p.pushStamp(2);
    expect(p.shiftStamp(9)).toBe(1);
    expect(p.shiftStamp(9)).toBe(2);
  });

  it('reset clears clock and stamps but keeps the adapted target and the counter', () => {
    const p = new AudioPlayout();
    p.schedule(10, 0.02, 0);
    p.schedule(11, 0.02, 0);
    p.pushStamp(1);
    const target = p.targetS;
    p.reset();
    expect(p.mediaTimeMs(12, 0)).toBeNull();
    expect(p.shiftStamp(7)).toBe(7);
    expect(p.targetS).toBe(target);
    expect(p.underruns).toBe(1);
    expect(p.schedule(12, 0.02, 0).underrun).toBe(false);
  });
});

const enc = (t: number, key = false): EncodedVideo => ({ t, key, data: new Uint8Array([key ? 1 : 0]) });

describe('VideoPlayout', () => {
  it('hands over, in order and starting at a keyframe, what falls due in the next 150 ms', () => {
    const v = new VideoPlayout<{ t: number }>();
    [850, 900, 933, 966, 1000, 1033, 1066, 1100, 1150, 1200].forEach((t) => v.enqueue(enc(t, t === 900)));
    const { chunks } = v.takeForDecode(1000, 0);
    expect(chunks.map((c) => c.t)).toEqual([900, 933, 966, 1000, 1033, 1066, 1100, 1150]);
    expect(chunks[0].key).toBe(true);
    expect(v.needKey).toBe(false);
  });

  it('delivers nothing while the decoder queue is full, and respects the remaining room', () => {
    const v = new VideoPlayout<{ t: number }>();
    [900, 933, 966].forEach((t) => v.enqueue(enc(t, t === 900)));
    expect(v.takeForDecode(1000, 8).chunks).toHaveLength(0);
    expect(v.takeForDecode(1000, 6).chunks).toHaveLength(2);
  });

  it('waits for a keyframe: deltas alone are dropped', () => {
    const v = new VideoPlayout<{ t: number }>();
    [900, 933].forEach((t) => v.enqueue(enc(t)));
    expect(v.takeForDecode(1000, 0).chunks).toHaveLength(0);
    expect(v.needKey).toBe(true);
  });

  it('far behind (> 1.5 s): jumps to the latest keyframe already due', () => {
    const v = new VideoPlayout<{ t: number }>();
    for (let t = 0; t <= 2000; t += 100) v.enqueue(enc(t, t === 0 || t === 2000));
    const out = v.takeForDecode(2500, 0);
    expect(out.skipped).toBeGreaterThan(0);
    expect(out.chunks[0]).toMatchObject({ t: 2000, key: true });
  });

  it('decoded queue is capped at 8: the oldest comes back to be closed', () => {
    const v = new VideoPlayout<{ t: number }>();
    for (let t = 0; t < 8; t++) expect(v.addDecoded({ t })).toEqual([]);
    expect(v.addDecoded({ t: 8 })).toEqual([{ t: 0 }]);
  });

  it('shows one frame at a time, in order, and only when it is due', () => {
    const v = new VideoPlayout<{ t: number }>();
    [1000, 1033, 1066].forEach((t) => v.addDecoded({ t }));
    expect(v.pick(990).frame).toBeNull();
    expect(v.pick(1010).frame).toEqual({ t: 1000 });
    expect(v.pick(1040).frame).toEqual({ t: 1033 });
  });

  it('drops frames that are more than 250 ms late when a newer one is waiting', () => {
    const v = new VideoPlayout<{ t: number }>();
    [600, 700, 900, 990].forEach((t) => v.addDecoded({ t }));
    const { frame, dropped } = v.pick(1000);
    expect(dropped).toEqual([{ t: 600 }]);
    expect(frame).toEqual({ t: 700 });
  });

  it('reset hands back what was decoded and asks for a keyframe again', () => {
    const v = new VideoPlayout<{ t: number }>();
    v.enqueue(enc(900, true));
    v.takeForDecode(1000, 0);
    v.enqueue(enc(950));
    v.addDecoded({ t: 900 });
    const r = v.reset();
    expect(r.decoded).toEqual([{ t: 900 }]);
    expect(r.pending).toBe(1);
    expect(v.needKey).toBe(true);
    expect(v.pick(5000).frame).toBeNull();
  });
});

describe('VideoPlayout bounds', () => {
  it('ignores frames whose timestamp is not finite', () => {
    const v = new VideoPlayout<{ t: number }>();
    [NaN, Infinity, -Infinity].forEach((t) => v.enqueue(enc(t, true)));
    expect(v.takeForDecode(1000, 0).chunks).toHaveLength(0);
    expect(v.pendingCount).toBe(0);
  });

  it('keeps the encoded queue bounded, cutting back to the latest keyframe', () => {
    const v = new VideoPlayout<{ t: number }>();
    for (let i = 0; i < 400; i++) v.enqueue(enc(i * 33, i === 0 || i === 250));
    expect(v.pendingCount).toBeLessThanOrEqual(v.MAX_ENCODED);
    const { chunks } = v.takeForDecode(400 * 33, 0);
    expect(chunks[0]).toMatchObject({ key: true, t: 250 * 33 });
  });

  it('with no keyframe to cut back to, drops everything and waits for one', () => {
    const v = new VideoPlayout<{ t: number }>();
    v.enqueue(enc(0, true));
    v.takeForDecode(100, 0); // consome o quadro-chave: o decodificador está em dia
    expect(v.needKey).toBe(false);
    for (let i = 1; i <= v.MAX_ENCODED + 1; i++) v.enqueue(enc(i * 33, false));
    expect(v.pendingCount).toBe(0);
    expect(v.needKey).toBe(true);
  });
});

describe('VideoOnlyClock (a broadcast without audio)', () => {
  it('stays null for the first second, then follows the wall clock buffered behind the newest frame', () => {
    const c = new VideoOnlyClock();
    c.note(5000, 0);
    expect(c.mediaTimeMs(500)).toBeNull();
    c.note(5900, 900);
    const s = c.mediaTimeMs(1000)!;
    expect(s).toBeCloseTo(5900 - 300, 6);
    expect(c.mediaTimeMs(1300)! - s).toBeCloseTo(300, 6);
  });

  it('ignores non-finite stamps and reset forgets the anchor', () => {
    const c = new VideoOnlyClock();
    c.note(NaN, 0);
    expect(c.mediaTimeMs(5000)).toBeNull();
    c.note(100, 0);
    expect(c.mediaTimeMs(1000)).not.toBeNull();
    c.reset();
    expect(c.mediaTimeMs(9000)).toBeNull();
  });
});
