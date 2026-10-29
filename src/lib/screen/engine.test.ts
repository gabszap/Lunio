import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screenQuality } from '../../types/screen';
import { FrameIntake } from './viewer';
import { KEY_SWITCH_DELAY_MS, ScreenPublisher, type AudioDataLike, type Capture, type PublisherBrowser, type PublisherEvents, type VideoFrameLike } from './publisher';
import { screenCapabilities } from './capabilities';
import { memoryTransport, type ScreenTransport, type TrackSource } from './transport';
import { FrameOpener, FrameSealer, generateScreenKey } from './wire';

const URL = 'https://relay.test/x';
const PATH = 'lunio/SALA/abc';

/** Leitor com fila: o teste empurra quadros e o publicador os lê como de um MediaStreamTrackProcessor. */
class Feed<T> {
  private queue: T[] = [];
  private waiting: ((r: { done: boolean; value?: T }) => void) | null = null;
  private ended = false;
  push(v: T) {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ done: false, value: v });
    } else this.queue.push(v);
  }
  end() {
    this.ended = true;
    this.waiting?.({ done: true });
    this.waiting = null;
  }
  reader = {
    read: (): Promise<{ done: boolean; value?: T }> => {
      if (this.queue.length) return Promise.resolve({ done: false, value: this.queue.shift() });
      if (this.ended) return Promise.resolve({ done: true });
      return new Promise((resolve) => (this.waiting = resolve));
    },
  };
}

function vframe(ms: number, w = 1280, h = 720): VideoFrameLike & { closed: boolean } {
  return { timestamp: ms * 1000, displayWidth: w, displayHeight: h, closed: false, close() { this.closed = true; } };
}
const aframe = (ms: number, durMs = 10): AudioDataLike => ({ timestamp: ms * 1000, duration: durMs * 1000, close() {} });

function setup(opts: { queueSize?: number } = {}) {
  const video = new Feed<VideoFrameLike>();
  const audio = new Feed<AudioDataLike>();
  const endedCbs: Array<() => void> = [];
  const capture = { stop: vi.fn() };
  const venc = { configured: [] as any[], encoded: 0, keys: [] as boolean[], closed: false, queue: opts.queueSize ?? 0 };
  let vHandlers: any;
  let aHandlers: any;
  const browser: PublisherBrowser = {
    async capture(): Promise<Capture> {
      return { video: video.reader, audio: audio.reader, onEnded: (cb) => endedCbs.push(cb), stop: capture.stop };
    },
    createVideoEncoder(h) {
      vHandlers = h;
      return {
        async configure(cfg) { venc.configured.push(cfg); },
        encode(f, o) {
          venc.encoded++;
          venc.keys.push(o.keyFrame);
          h.output({ key: o.keyFrame, data: new Uint8Array([o.keyFrame ? 1 : 0, 2, 3]), timestampUs: f.timestamp });
        },
        get encodeQueueSize() { return venc.queue; },
        close() { venc.closed = true; },
      };
    },
    createAudioEncoder(h) {
      aHandlers = h;
      return {
        async configure() {},
        encode(d) { h.output({ data: new Uint8Array([9, 9]), timestampUs: d.timestamp }); },
        close() {},
      };
    },
  };
  const transport = memoryTransport();
  const events = { onEnded: vi.fn(), onUsage: vi.fn() } satisfies PublisherEvents;
  const publisher = new ScreenPublisher({ transport, browser }, events);
  return { video, audio, endedCbs, capture, venc, transport, events, publisher, errors: { video: () => vHandlers.error(new Error('boom')), audio: () => aHandlers.error(new Error('boom')) } };
}

const tick = () => vi.advanceTimersByTimeAsync(1);

async function startPublisher(s: ReturnType<typeof setup>, quality = '720p30') {
  const initialKey = await generateScreenKey(1);
  await s.publisher.start({ url: URL, path: PATH, quality: screenQuality(quality)!, initialKey });
  return initialKey;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ScreenPublisher', () => {
  it('decimates 60 fps capture to the chosen fps and starts on a keyframe', async () => {
    const s = setup();
    await startPublisher(s, '720p30');
    for (let i = 0; i < 20; i++) s.video.push(vframe(i * (1000 / 60)));
    await tick();
    expect(s.venc.encoded).toBe(10);
    expect(s.venc.keys[0]).toBe(true);
    expect(s.venc.keys.slice(1).every((k) => !k)).toBe(true);
  });

  it('forces a keyframe every two seconds (60 frames at 30 fps) and opens a group for each', async () => {
    const s = setup();
    await startPublisher(s, '720p30');
    for (let i = 0; i < 130; i++) s.video.push(vframe(i * (1000 / 30)));
    await tick();
    expect(s.venc.keys.map((k, i) => (k ? i : -1)).filter((i) => i >= 0)).toEqual([0, 60, 120]);
    await s.publisher.flush();
    expect(s.transport.groups(PATH, 'video').map((g) => g.length)).toEqual([60, 60, 10]);
  });

  it('configures the encoder from the real frame size and again when it changes, restarting on a keyframe', async () => {
    const s = setup();
    await startPublisher(s, '1080p30');
    s.video.push(vframe(0, 1920, 1080));
    s.video.push(vframe(40, 1920, 1080));
    s.video.push(vframe(80, 1280, 720));
    await tick();
    expect(s.venc.configured.map((c) => [c.width, c.height])).toEqual([[1920, 1080], [1280, 720]]);
    expect(s.venc.keys).toEqual([true, false, true]);
  });

  it('skips frames while the encoder queue is long and counts them', async () => {
    const s = setup({ queueSize: 5 });
    await startPublisher(s, '720p30');
    s.video.push(vframe(0));
    s.video.push(vframe(40));
    await tick();
    expect(s.venc.encoded).toBe(0);
    expect(s.publisher.stats.queueDrops).toBe(2);
  });

  it('what reaches the relay is encrypted and opens with the session key, stamps rising', async () => {
    const s = setup();
    const key = await startPublisher(s, '720p30');
    const opener = new FrameOpener();
    await opener.addKey(key);
    const src = (await s.transport.watch(URL, PATH)).track('video');
    for (let i = 0; i < 5; i++) s.video.push(vframe(i * 34));
    await tick();
    await s.publisher.flush();
    await s.publisher.stop();
    const stamps: number[] = [];
    for await (const p of src.frames()) {
      const o = (await opener.open(p))!;
      expect(o.data.length).toBe(3);
      stamps.push(o.stamp);
    }
    expect(stamps).toHaveLength(5);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it('audio goes out in one-second groups', async () => {
    const s = setup();
    await startPublisher(s);
    for (let i = 0; i < 250; i++) s.audio.push(aframe(i * 10));
    await tick();
    await s.publisher.flush();
    expect(s.transport.groups(PATH, 'audio').map((g) => g.length)).toEqual([100, 100, 50]);
  });

  it('stop is idempotent: closes capture, encoders and transport once, no onEnded', async () => {
    const s = setup();
    await startPublisher(s);
    await s.publisher.stop();
    await s.publisher.stop();
    expect(s.capture.stop).toHaveBeenCalledTimes(1);
    expect(s.venc.closed).toBe(true);
    expect(s.events.onEnded).not.toHaveBeenCalled();
    s.video.push(vframe(0));
    await tick();
    expect(s.venc.encoded).toBe(0);
  });

  it('the capture ending (browser stop button) reports once and cleans up', async () => {
    const s = setup();
    await startPublisher(s);
    s.endedCbs.forEach((cb) => cb());
    s.endedCbs.forEach((cb) => cb());
    await tick();
    expect(s.events.onEnded).toHaveBeenCalledTimes(1);
    expect(s.events.onEnded).toHaveBeenCalledWith('user', undefined);
    expect(s.capture.stop).toHaveBeenCalledTimes(1);
    await expect(s.publisher.stop()).resolves.toBeUndefined();
  });

  it('an encoder error ends the broadcast with reason error', async () => {
    const s = setup();
    await startPublisher(s);
    s.errors.video();
    await tick();
    expect(s.events.onEnded).toHaveBeenCalledWith('error', expect.any(String));
    expect(s.capture.stop).toHaveBeenCalledTimes(1);
  });

  it('reports the bytes published every 3 s, growing', async () => {
    const s = setup();
    await startPublisher(s);
    s.video.push(vframe(0));
    await tick();
    await s.publisher.flush();
    await vi.advanceTimersByTimeAsync(3000);
    const first = s.events.onUsage.mock.calls.at(-1)![0];
    expect(first).toBeGreaterThan(0);
    s.video.push(vframe(40));
    s.video.push(vframe(80));
    await tick();
    await s.publisher.flush();
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.events.onUsage.mock.calls.at(-1)![0]).toBeGreaterThan(first);
  });

  it('rotateKey gives the next epoch and only seals with it after the switch delay', async () => {
    const s = setup();
    const key1 = await startPublisher(s);
    const next = await s.publisher.rotateKey();
    expect(next.epoch).toBe(key1.epoch + 1);
    expect(KEY_SWITCH_DELAY_MS).toBe(400);

    const epochs: number[] = [];
    const src = (await s.transport.watch(URL, PATH)).track('video');
    void (async () => {
      for await (const p of src.frames()) epochs.push(p[9]);
    })();
    const sendFrame = async (ms: number) => {
      s.video.push(vframe(ms));
      await tick();
      await s.publisher.flush();
      await tick();
    };
    await sendFrame(0);
    await vi.advanceTimersByTimeAsync(KEY_SWITCH_DELAY_MS);
    await sendFrame(100);
    expect(epochs).toEqual([1, 2]);
  });

  it('a failure to publish releases the capture and rejects', async () => {
    const s = setup();
    const failing: ScreenTransport = { publish: () => Promise.reject(new Error('sem relay')), watch: s.transport.watch };
    const p = new ScreenPublisher({ transport: failing, browser: (s.publisher as any).deps.browser }, s.events);
    await expect(p.start({ url: URL, path: PATH, quality: screenQuality('720p30')!, initialKey: await generateScreenKey(1) })).rejects.toThrow('sem relay');
    expect(s.capture.stop).toHaveBeenCalled();
  });
});

describe('FrameIntake', () => {
  const sourceOf = (payloads: Uint8Array[], throwAfter = false): TrackSource => ({
    frames: async function* () {
      for (const p of payloads) yield p;
      if (throwAfter) throw new Error('conexão caiu');
    },
    close() {},
  });

  async function sealed(n: number, epoch = 1) {
    const key = await generateScreenKey(epoch);
    const sealer = new FrameSealer();
    await sealer.setKey(key);
    const out: Uint8Array[] = [];
    for (let i = 0; i < n; i++) out.push(await sealer.seal('video', i, i === 0, new Uint8Array([i])));
    return { key, out };
  }

  it('delivers opened frames in order', async () => {
    const { key, out } = await sealed(3);
    const opener = new FrameOpener();
    await opener.addKey(key);
    const got: number[] = [];
    const r = await new FrameIntake(opener).run(sourceOf(out), (o) => got.push(o.data[0]), () => true);
    expect(got).toEqual([0, 1, 2]);
    expect(r).toBe('ended');
  });

  it('a malformed or tampered payload does not stop the loop', async () => {
    const { key, out } = await sealed(3);
    const opener = new FrameOpener();
    await opener.addKey(key);
    const tampered = out[1].slice();
    tampered[tampered.length - 1] ^= 1;
    const got: number[] = [];
    await new FrameIntake(opener).run(sourceOf([out[0], new Uint8Array(5), new Uint8Array(0), tampered, out[2]]), (o) => got.push(o.data[0]), () => true);
    expect(got).toEqual([0, 2]);
    expect(opener.counts.malformed).toBe(2);
    expect(opener.counts.badTag).toBe(1);
  });

  it('frames sealed with a key that arrives later are ignored until addKey, then flow', async () => {
    const { key, out } = await sealed(4, 2);
    const opener = new FrameOpener();
    const got: number[] = [];
    const intake = new FrameIntake(opener);
    await intake.run(sourceOf(out.slice(0, 2)), (o) => got.push(o.data[0]), () => true);
    expect(got).toEqual([]);
    expect(opener.counts.noKey).toBe(2);
    await opener.addKey(key);
    await intake.run(sourceOf(out.slice(2)), (o) => got.push(o.data[0]), () => true);
    expect(got).toEqual([2, 3]);
  });

  it('a source that throws resolves as error instead of throwing, and a stale generation stops delivering', async () => {
    const { key, out } = await sealed(2);
    const opener = new FrameOpener();
    await opener.addKey(key);
    const intake = new FrameIntake(opener);
    await expect(intake.run(sourceOf(out, true), () => {}, () => true)).resolves.toBe('error');
    const got: number[] = [];
    await intake.run(sourceOf(out), (o) => got.push(o.data[0]), () => false);
    expect(got).toEqual([]);
  });

  it('a callback that throws does not kill the loop', async () => {
    const { key, out } = await sealed(3);
    const opener = new FrameOpener();
    await opener.addKey(key);
    const got: number[] = [];
    await new FrameIntake(opener).run(
      sourceOf(out),
      (o) => {
        if (o.data[0] === 1) throw new Error('decoder recusou');
        got.push(o.data[0]);
      },
      () => true,
    );
    expect(got).toEqual([0, 2]);
  });
});

describe('screenCapabilities', () => {
  afterEach(() => vi.unstubAllGlobals());

  const chromium = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  const full = (ua: string) => {
    vi.stubGlobal('navigator', { userAgent: ua, mediaDevices: { getDisplayMedia() {} } });
    for (const n of ['MediaStreamTrackProcessor', 'VideoEncoder', 'AudioEncoder', 'VideoDecoder', 'AudioDecoder', 'WebTransport', 'AudioContext']) vi.stubGlobal(n, class {});
  };

  it('desktop Chromium can host and watch', () => {
    full(chromium);
    expect(screenCapabilities()).toMatchObject({ host: true, viewer: true });
  });

  it('a phone can watch but not host', () => {
    full(chromium + ' Mobile');
    const c = screenCapabilities();
    expect(c.host).toBe(false);
    expect(c.viewer).toBe(true);
    expect(c.reason).toBeTruthy();
  });

  it('without WebTransport it can do neither', () => {
    full(chromium);
    vi.stubGlobal('WebTransport', undefined);
    expect(screenCapabilities()).toMatchObject({ host: false, viewer: false });
  });

  it('without getDisplayMedia or the track processor it cannot host (Firefox) but can watch', () => {
    full('Mozilla/5.0 (Windows NT 10.0; rv:130.0) Gecko/20100101 Firefox/130.0');
    vi.stubGlobal('MediaStreamTrackProcessor', undefined);
    expect(screenCapabilities()).toMatchObject({ host: false, viewer: true });
  });
});
