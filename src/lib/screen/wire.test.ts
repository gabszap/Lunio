import { describe, expect, it } from 'vitest';
import { isValidScreenKey } from '../../server/screenShare';
import { FrameOpener, FrameSealer, generateScreenKey } from './wire';

const bytes = (n: number, v = 7) => new Uint8Array(n).fill(v);

async function pair(epoch = 1) {
  const material = await generateScreenKey(epoch);
  const sealer = new FrameSealer();
  await sealer.setKey(material);
  const opener = new FrameOpener();
  await opener.addKey(material);
  return { material, sealer, opener };
}

describe('generateScreenKey', () => {
  it('makes a 32-byte base64 key the server accepts', async () => {
    const m = await generateScreenKey(3);
    expect(m.epoch).toBe(3);
    expect(isValidScreenKey(m.key)).toBe(true);
  });

  it('does not repeat', async () => {
    expect((await generateScreenKey(1)).key).not.toBe((await generateScreenKey(1)).key);
  });
});

describe('FrameSealer / FrameOpener', () => {
  it('round-trips a keyframe and a delta frame', async () => {
    const { sealer, opener } = await pair();
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    expect(await opener.open(await sealer.seal('video', 1234.5, true, data))).toEqual({ stamp: 1234.5, key: true, data });
    expect(await opener.open(await sealer.seal('video', 99, false, data))).toMatchObject({ stamp: 99, key: false });
    expect(opener.counts.ok).toBe(2);
  });

  it('keeps the header in clear and sizes the payload as header + iv + data + tag', async () => {
    const { sealer } = await pair(300);
    const p = await sealer.seal('audio', 42.25, true, bytes(100));
    const dv = new DataView(p.buffer, p.byteOffset);
    expect(dv.getFloat64(0)).toBe(42.25);
    expect(p[8]).toBe(1);
    expect(p[9]).toBe(300 & 255);
    expect(p.length).toBe(10 + 12 + 100 + 16);
  });

  it('never repeats an IV and restarts the counter on a new key', async () => {
    const { sealer } = await pair();
    const ivs = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ivs.add(Buffer.from((await sealer.seal('video', i, false, bytes(4))).subarray(10, 22)).toString('hex'));
      ivs.add(Buffer.from((await sealer.seal('audio', i, true, bytes(4))).subarray(10, 22)).toString('hex'));
    }
    expect(ivs.size).toBe(2000);
    await sealer.setKey(await generateScreenKey(2));
    const first = await sealer.seal('video', 0, true, bytes(4));
    // [faixa][7 bytes aleatórios][contador u32]: o contador recomeça em zero com a chave nova
    expect(first[10]).toBe(1);
    expect(Buffer.from(first.subarray(18, 22)).toString('hex')).toBe('00000000');
  });

  it('two sealers using the same key material never share an IV prefix (a restarted Host must not repeat nonces)', async () => {
    const key = await generateScreenKey(1);
    const a = new FrameSealer();
    const b = new FrameSealer();
    await a.setKey(key);
    await b.setKey(key);
    const ivA = (await a.seal('video', 1, true, bytes(4))).subarray(10, 22);
    const ivB = (await b.seal('video', 1, true, bytes(4))).subarray(10, 22);
    expect(Buffer.from(ivA).toString('hex')).not.toBe(Buffer.from(ivB).toString('hex'));
  });

  it('refuses a frame whose timestamp is not a finite number', async () => {
    const { sealer, opener } = await pair();
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(await opener.open(await sealer.seal('video', bad, true, bytes(8)))).toBeNull();
    }
    expect(opener.counts.malformed).toBe(3);
    expect(opener.counts.ok).toBe(0);
  });

  it('refuses a tampered header or ciphertext, a short payload and an unknown epoch', async () => {
    const { sealer, opener } = await pair();
    const good = await sealer.seal('video', 5, true, bytes(32));
    const header = good.slice();
    header[3] ^= 1;
    const body = good.slice();
    body[40] ^= 1;
    expect(await opener.open(header)).toBeNull();
    expect(await opener.open(body)).toBeNull();
    expect(opener.counts.badTag).toBe(2);

    expect(await opener.open(new Uint8Array(5))).toBeNull();
    expect(opener.counts.malformed).toBe(1);

    const other = new FrameSealer();
    await other.setKey(await generateScreenKey(2));
    expect(await opener.open(await other.seal('video', 5, true, bytes(8)))).toBeNull();
    expect(opener.counts.noKey).toBe(1);
  });

  it('opens old frames while both epochs are known, and new ones only after addKey', async () => {
    const k1 = await generateScreenKey(1);
    const k2 = await generateScreenKey(2);
    const sealer = new FrameSealer();
    const opener = new FrameOpener();
    await opener.addKey(k1);
    await sealer.setKey(k1);
    const old = await sealer.seal('video', 1, true, bytes(8));
    await sealer.setKey(k2);
    const fresh = await sealer.seal('video', 2, true, bytes(8));

    expect(await opener.open(fresh)).toBeNull();
    await opener.addKey(k2);
    expect(await opener.open(old)).not.toBeNull();
    expect(await opener.open(fresh)).not.toBeNull();
  });

  it('keeps only the four most recent keys', async () => {
    const opener = new FrameOpener();
    const sealer = new FrameSealer();
    const keys = await Promise.all([1, 2, 3, 4, 5].map((e) => generateScreenKey(e)));
    for (const k of keys) await opener.addKey(k);
    await sealer.setKey(keys[0]);
    expect(await opener.open(await sealer.seal('video', 1, true, bytes(4)))).toBeNull();
    await sealer.setKey(keys[4]);
    expect(await opener.open(await sealer.seal('video', 1, true, bytes(4)))).not.toBeNull();
  });

  it('throws when sealing without a key', async () => {
    await expect(new FrameSealer().seal('video', 1, true, bytes(4))).rejects.toThrow();
  });
});
