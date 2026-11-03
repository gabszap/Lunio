import { describe, expect, it } from 'vitest';
import { memoryTransport, type ScreenTransport } from './transport';

/**
 * Bateria de contrato: o que qualquer `ScreenTransport` precisa cumprir. Roda no transporte em memória; o adaptador do
 * `@moq/net` (WebTransport, que não existe no Node) cumpre as mesmas regras e é conferido contra o relay de verdade.
 */
function contract(name: string, make: () => ScreenTransport) {
  const URL = 'https://relay.test/x';
  const PATH = 'lunio/SALA/abc';
  const frame = (n: number) => new Uint8Array([n]);

  describe(`ScreenTransport contract (${name})`, () => {
    it('delivers published payloads in order across groups', async () => {
      const t = make();
      const pub = await t.publish(URL, PATH);
      const src = (await t.watch(URL, PATH)).track('video');
      [1, 2, 3].forEach((n, i) => pub.video.write(frame(n), i, i !== 1));
      pub.close();
      const got: number[] = [];
      for await (const f of src.frames()) got.push(f[0]);
      expect(got).toEqual([1, 2, 3]);
    });

    it('closing a source ends its iterator without hanging', async () => {
      const t = make();
      await t.publish(URL, PATH);
      const src = (await t.watch(URL, PATH)).track('audio');
      const done = (async () => {
        for await (const _ of src.frames()) void _;
        return 'ended';
      })();
      src.close();
      await expect(done).resolves.toBe('ended');
    });

    it('watch rejects when the signal is already aborted', async () => {
      const t = make();
      const ctl = new AbortController();
      ctl.abort();
      await expect(t.watch(URL, PATH, ctl.signal)).rejects.toThrow();
    });

    it('watch waits for the broadcast and stops waiting on abort', async () => {
      const t = make();
      const ctl = new AbortController();
      const waiting = t.watch(URL, PATH, ctl.signal);
      ctl.abort();
      await expect(waiting).rejects.toThrow();

      const late = t.watch(URL, PATH);
      await t.publish(URL, PATH);
      await expect(late).resolves.toBeDefined();
    });

    it('two viewers receive the same sequence', async () => {
      const t = make();
      const pub = await t.publish(URL, PATH);
      const a = (await t.watch(URL, PATH)).track('video');
      const b = (await t.watch(URL, PATH)).track('video');
      [7, 8, 9].forEach((n, i) => pub.video.write(frame(n), i, i === 0));
      pub.close();
      const read = async (s: typeof a) => {
        const out: number[] = [];
        for await (const f of s.frames()) out.push(f[0]);
        return out;
      };
      expect(await read(a)).toEqual([7, 8, 9]);
      expect(await read(b)).toEqual([7, 8, 9]);
    });
  });
}

contract('memory', memoryTransport);
