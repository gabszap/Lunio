import { describe, expect, it } from 'vitest';
import { AUDIO_GROUP_MS, FrameMuxer } from './muxer';
import { memoryTransport, type TrackSink } from './transport';
import { FrameOpener, FrameSealer, generateScreenKey } from './wire';

const URL = 'https://relay.test/x';
const PATH = 'lunio/SALA/abc';
const data = (n = 8) => new Uint8Array(n).fill(3);

async function setup() {
  const key = await generateScreenKey(1);
  const sealer = new FrameSealer();
  await sealer.setKey(key);
  const opener = new FrameOpener();
  await opener.addKey(key);
  const transport = memoryTransport();
  const pub = await transport.publish(URL, PATH);
  const muxer = new FrameMuxer(sealer, { video: pub.video, audio: pub.audio });
  return { sealer, opener, transport, pub, muxer };
}

describe('FrameMuxer video groups', () => {
  it('opens a group on every keyframe', async () => {
    const { transport, muxer } = await setup();
    [true, false, false, true, false, true, false].forEach((key, i) => muxer.pushVideo({ key, data: data(), timestampUs: i * 33_000 }, i));
    await muxer.flush();
    expect(transport.groups(PATH, 'video').map((g) => g.length)).toEqual([3, 2, 2]);
  });

  it('drops delta frames that arrive before the first keyframe', async () => {
    const { transport, muxer } = await setup();
    muxer.pushVideo({ key: false, data: data(), timestampUs: 0 }, 0);
    muxer.pushVideo({ key: false, data: data(), timestampUs: 1 }, 1);
    muxer.pushVideo({ key: true, data: data(), timestampUs: 2 }, 2);
    muxer.pushVideo({ key: false, data: data(), timestampUs: 3 }, 3);
    await muxer.flush();
    expect(transport.groups(PATH, 'video').map((g) => g.length)).toEqual([2]);
    expect(muxer.dropped).toBe(2);
    expect(muxer.bytesOut).toBe(2 * (10 + 12 + 8 + 16));
  });
});

describe('FrameMuxer audio groups', () => {
  it('cuts a group every 1000 ms of media, never one group per frame', async () => {
    const { transport, muxer } = await setup();
    expect(AUDIO_GROUP_MS).toBe(1000);
    for (let i = 0; i < 125; i++) muxer.pushAudio({ data: data(), timestampUs: i * 20_000 }, i * 20);
    await muxer.flush();
    expect(transport.groups(PATH, 'audio').map((g) => g.length)).toEqual([50, 50, 25]);
  });
});

describe('FrameMuxer ordering and accounting', () => {
  it('keeps the order of a burst even though sealing is async', async () => {
    const { opener, transport, muxer } = await setup();
    const watch = await transport.watch(URL, PATH);
    const source = watch.track('video');
    for (let i = 0; i < 200; i++) muxer.pushVideo({ key: i === 0, data: data(), timestampUs: i }, 1000 + i);
    await muxer.flush();
    const stamps: number[] = [];
    for await (const payload of source.frames()) {
      stamps.push((await opener.open(payload))!.stamp);
      if (stamps.length === 200) break;
    }
    expect(stamps).toEqual(Array.from({ length: 200 }, (_, i) => 1000 + i));
  });

  it('does not write or throw while there is no key', async () => {
    const transport = memoryTransport();
    const pub = await transport.publish(URL, PATH);
    const muxer = new FrameMuxer(new FrameSealer(), { video: pub.video, audio: pub.audio });
    expect(() => muxer.pushVideo({ key: true, data: data(), timestampUs: 0 }, 0)).not.toThrow();
    muxer.pushAudio({ data: data(), timestampUs: 0 }, 0);
    await muxer.flush();
    expect(muxer.dropped).toBe(2);
    expect(muxer.bytesOut).toBe(0);
  });

  it('a sink that throws drops that frame and the rest still flow', async () => {
    const { sealer } = await setup();
    let calls = 0;
    const written: number[] = [];
    const flaky: TrackSink = {
      write: (p) => {
        if (calls++ === 0) throw new Error('boom');
        written.push(p.length);
      },
      close() {},
    };
    const muxer = new FrameMuxer(sealer, { video: flaky, audio: flaky });
    muxer.pushVideo({ key: true, data: data(), timestampUs: 0 }, 0);
    muxer.pushVideo({ key: false, data: data(), timestampUs: 1 }, 1);
    await muxer.flush();
    expect(written).toHaveLength(1);
    expect(muxer.dropped).toBe(1);
  });
});

describe('memoryTransport', () => {
  it('hasSubscribers follows the viewers', async () => {
    const { transport, pub } = await setup();
    expect(pub.hasSubscribers()).toBe(false);
    const watch = await transport.watch(URL, PATH);
    const src = watch.track('video');
    expect(pub.hasSubscribers()).toBe(true);
    src.close();
    expect(pub.hasSubscribers()).toBe(false);
  });

  it('delivers exactly what was published and ends when the publisher closes', async () => {
    const { transport, pub } = await setup();
    const src = (await transport.watch(URL, PATH)).track('audio');
    const sent = [new Uint8Array([1]), new Uint8Array([2, 2]), new Uint8Array([3])];
    pub.audio.write(sent[0], 0, true);
    pub.audio.write(sent[1], 1, false);
    pub.audio.write(sent[2], 2, true);
    pub.close();
    const got: number[][] = [];
    for await (const f of src.frames()) got.push([...f]);
    expect(got).toEqual([[1], [2, 2], [3]]);
  });
});
