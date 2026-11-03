import { describe, expect, it, vi } from 'vitest';
import type { VideoAddon } from './addons';
import { fetchStreams, type StreamTarget, normalizeStreams, sortStreams, streamRequestUrl, type SourceResult, type StreamOption } from './streams';

const SUPPORT = { hevc: false, av1: false, ac3: false, eac3: false };

const addon = (id: string, over: Partial<VideoAddon['stream']> = {}): VideoAddon => ({
  id,
  name: `Addon ${id}`,
  manifestUrl: `https://addon.test/${id}/manifest.json`,
  base: `https://addon.test/${id}`,
  stream: { types: ['movie', 'series'], idPrefixes: ['tt'], ...over },
});

const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;
const html = () => ({ ok: true, json: async () => Promise.reject(new SyntaxError('<html>')) }) as unknown as Response;

const opt = (url: string, level: StreamOption['level']): StreamOption => ({
  key: url,
  sourceId: 'a',
  sourceName: 'A',
  title: 't',
  description: 'd',
  url,
  codecs: { dolbyVision: false, audio: [] },
  level,
  reasons: [],
});

describe('streamRequestUrl', () => {
  it('codifica o id', () => {
    expect(streamRequestUrl(addon('a'), 'series', 'tt2359704:6:1')).toBe('https://addon.test/a/stream/series/tt2359704%3A6%3A1.json');
  });
});

describe('normalizeStreams', () => {
  it('converte item bom e classifica', () => {
    const { options, dropped } = normalizeStreams(
      addon('a'),
      { streams: [{ name: 'Rd 1080p', description: 'x264 AAC', url: 'https://cdn.test/v.mp4', behaviorHints: { filename: 'v.mp4' } }] },
      SUPPORT,
    );
    expect(dropped).toBe(0);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      key: 'https://cdn.test/v.mp4',
      sourceId: 'a',
      sourceName: 'Addon a',
      title: 'Rd 1080p',
      description: 'x264 AAC',
      filename: 'v.mp4',
      level: 'ok',
    });
    expect(options[0].codecs.videoCodec).toBe('h264');
  });

  it('descarta sem url, esquema não http(s) e [❌], contando', () => {
    const { options, dropped } = normalizeStreams(
      addon('a'),
      {
        streams: [
          { name: 'sem url' },
          { name: 'x', url: 'javascript:alert(1)' },
          { name: 'x', url: 'data:text/html,hi' },
          { name: 'x', url: 'magnet:?xt=urn:btih:abc' },
          { name: '[❌] X', url: 'https://cdn.test/e.mp4' },
          { name: 'bom', url: 'http://cdn.test/ok.mp4' },
        ],
      },
      SUPPORT,
    );
    expect(options.map((o) => o.url)).toEqual(['http://cdn.test/ok.mp4']);
    expect(dropped).toBe(5);
  });

  it('usa title do addon antigo como description', () => {
    const { options } = normalizeStreams(addon('a'), { streams: [{ name: 'N', title: ' Legado 720p ', url: 'https://cdn.test/a.mp4' }] }, SUPPORT);
    expect(options[0].description).toBe(' Legado 720p ');
  });

  it('proxyHeaders com chaves e notWebReady viram nível no', () => {
    const { options } = normalizeStreams(
      addon('a'),
      {
        streams: [
          { name: 'a', url: 'https://cdn.test/1.mp4', behaviorHints: { proxyHeaders: { request: { Referer: 'x' } } } },
          { name: 'b', url: 'https://cdn.test/2.mp4', behaviorHints: { notWebReady: true } },
          { name: 'c', url: 'https://cdn.test/3.mp4', behaviorHints: { proxyHeaders: { request: {} } } },
        ],
      },
      SUPPORT,
    );
    expect(options.map((o) => o.level)).toEqual(['no', 'no', 'maybe']);
  });

  it('entrada inválida não quebra', () => {
    expect(normalizeStreams(addon('a'), null, SUPPORT)).toEqual({ options: [], dropped: 0 });
    expect(normalizeStreams(addon('a'), { streams: [null, 3, 'x'] }, SUPPORT).dropped).toBe(3);
  });
});

describe('sortStreams', () => {
  it('ordena ok, maybe, no de forma estável e remove url repetida', () => {
    const out = sortStreams([opt('u1', 'no'), opt('u2', 'ok'), opt('u3', 'maybe'), opt('u4', 'ok'), opt('u2', 'ok'), opt('u1', 'ok')]);
    expect(out.map((o) => o.url)).toEqual(['u2', 'u4', 'u3', 'u1']);
    expect(out.find((o) => o.url === 'u1')!.level).toBe('no');
  });
});

describe('fetchStreams', () => {
  const target: StreamTarget = { type: 'movie', videoId: 'tt1' };
  const stream = (url: string) => ({ streams: [{ name: 'n', url }] });

  async function run(addons: VideoAddon[], fetchImpl: typeof fetch, over: Record<string, unknown> = {}, t: StreamTarget = target) {
    const results: SourceResult[] = [];
    const ctrl = new AbortController();
    await fetchStreams(addons, t, { support: SUPPORT, signal: ctrl.signal, onSource: (r) => results.push(r), fetchImpl, ...over });
    return results;
  }

  it('falha isolada por addon: HTML e 200 sem streams', async () => {
    const f = vi.fn(async (u: RequestInfo | URL) => {
      const s = String(u);
      if (s.includes('/bad/')) return html();
      if (s.includes('/empty/')) return json({});
      return json(stream('https://cdn.test/v.mp4'));
    }) as unknown as typeof fetch;
    const res = await run([addon('bad'), addon('empty'), addon('good')], f);
    const by = Object.fromEntries(res.map((r) => [r.addon.id, r]));
    expect(by.bad.failed).toBe(true);
    expect(by.empty.failed).toBe(true);
    expect(by.good.failed).toBe(false);
    expect(by.good.options).toHaveLength(1);
  });

  it('HTTP não ok é falha', async () => {
    const res = await run([addon('a')], (async () => json({}, false)) as unknown as typeof fetch);
    expect(res[0].failed).toBe(true);
  });

  it('timeout vira failed', async () => {
    const never = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abort'))))) as unknown as typeof fetch;
    const res = await run([addon('a')], never, { timeoutMs: 20 });
    expect(res).toHaveLength(1);
    expect(res[0].failed).toBe(true);
  });

  it('timeout vale mesmo se o fetch ignora o signal', async () => {
    const res = await run([addon('a')], (() => new Promise(() => {})) as unknown as typeof fetch, { timeoutMs: 20 });
    expect(res[0].failed).toBe(true);
  });

  it('abortado não chama onSource', async () => {
    const ctrl = new AbortController();
    const onSource = vi.fn();
    const f = (async () => {
      await new Promise((r) => setTimeout(r, 30));
      return json(stream('https://cdn.test/v.mp4'));
    }) as unknown as typeof fetch;
    const p = fetchStreams([addon('a')], target, { support: SUPPORT, signal: ctrl.signal, onSource, fetchImpl: f });
    ctrl.abort();
    await p;
    await new Promise((r) => setTimeout(r, 50));
    expect(onSource).not.toHaveBeenCalled();
  });

  it('já abortado não faz pedido', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const f = vi.fn() as unknown as typeof fetch;
    await fetchStreams([addon('a')], target, { support: SUPPORT, signal: ctrl.signal, onSource: vi.fn(), fetchImpl: f });
    expect(f).not.toHaveBeenCalled();
  });

  it('addon que não serve tipo/prefixo não recebe pedido', async () => {
    const f = vi.fn(async () => json(stream('https://cdn.test/v.mp4'))) as unknown as typeof fetch;
    const res = await run([addon('t', { types: ['series'] }), addon('p', { idPrefixes: ['kitsu:'] }), addon('ok')], f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(res.map((r) => r.addon.id)).toEqual(['ok']);
  });

  describe('fallback do id do episódio', () => {
    const ep = { type: 'series' as const, videoId: 'mal:1:6:1', seriesId: 'tt2359704', season: 6, episode: 1 };
    const a = addon('a', { idPrefixes: null });
    const meta = { meta: { videos: [{ id: 'tt2359704:5:1', season: 5, episode: 1 }, { id: 'tt2359704:6:1', season: 6, episode: 1 }] } };

    it('refaz o pedido com o id do meta', async () => {
      const urls: string[] = [];
      const f = (async (u: RequestInfo | URL) => {
        const s = String(u);
        urls.push(s);
        if (s.includes('/meta/')) return json(meta);
        if (s.includes('tt2359704%3A6%3A1')) return json(stream('https://cdn.test/e.mp4'));
        return json({ streams: [{ name: '[❌] erro', url: 'https://cdn.test/x.mp4' }] });
      }) as unknown as typeof fetch;
      const res = await run([a], f, {}, ep);
      expect(urls).toEqual([
        'https://addon.test/a/stream/series/mal%3A1%3A6%3A1.json',
        'https://addon.test/a/meta/series/tt2359704.json',
        'https://addon.test/a/stream/series/tt2359704%3A6%3A1.json',
      ]);
      expect(res).toHaveLength(1);
      expect(res[0].options).toHaveLength(1);
      expect(res[0].failed).toBe(false);
    });

    it('no máximo uma nova tentativa', async () => {
      const urls: string[] = [];
      const f = (async (u: RequestInfo | URL) => {
        const s = String(u);
        urls.push(s);
        if (s.includes('/meta/')) return json(meta);
        return json({}, false);
      }) as unknown as typeof fetch;
      const res = await run([a], f, {}, ep);
      expect(urls).toHaveLength(3);
      expect(res).toHaveLength(1);
      expect(res[0].failed).toBe(true);
    });

    it('retry ok mas vazio mantém o primeiro resultado com o dropped', async () => {
      const f = (async (u: RequestInfo | URL) => {
        const s = String(u);
        if (s.includes('/meta/')) return json(meta);
        if (s.includes('tt2359704%3A6%3A1')) return json({ streams: [] });
        return json({ streams: [{ name: '[❌] erro', url: 'https://cdn.test/x.mp4' }] });
      }) as unknown as typeof fetch;
      const res = await run([a], f, {}, ep);
      expect(res).toHaveLength(1);
      expect(res[0].options).toHaveLength(0);
      expect(res[0].dropped).toBe(1);
      expect(res[0].failed).toBe(false);
    });

    it('sem episódio no meta ou sem dados de série, não repete', async () => {
      const f = vi.fn(async (u: RequestInfo | URL) =>
        String(u).includes('/meta/') ? json({ meta: { videos: [] } }) : json({}, false),
      ) as unknown as typeof fetch;
      await run([a], f, {}, ep);
      expect(f).toHaveBeenCalledTimes(2);
      const g = vi.fn(async () => json({}, false)) as unknown as typeof fetch;
      await run([a], g, {}, { type: 'series', videoId: 'tt1:1:1' });
      expect(g).toHaveBeenCalledTimes(1);
    });

    it('resposta com itens bons não dispara fallback', async () => {
      const f = vi.fn(async () => json(stream('https://cdn.test/v.mp4'))) as unknown as typeof fetch;
      await run([a], f, {}, ep);
      expect(f).toHaveBeenCalledTimes(1);
    });
  });

  it('o resultado emitido não carrega a url do addon', async () => {
    const f = (async (u: RequestInfo | URL) => (String(u).includes('/bad/') ? html() : json(stream('https://cdn.test/v.mp4')))) as unknown as typeof fetch;
    const res = await run([addon('bad'), addon('good')], f);
    expect(res).toHaveLength(2);
    for (const r of res) {
      const out = JSON.stringify(r);
      expect(out).not.toContain('addon.test');
      expect(out).not.toContain('manifestUrl');
      expect(out).not.toContain('base');
    }
  });

  it('a união de duas fontes com a mesma url sai uma vez no sortStreams', async () => {
    const f = vi.fn(async () => json(stream('https://cdn.test/same.mp4'))) as unknown as typeof fetch;
    const res = await run([addon('a'), addon('b')], f);
    const all = res.flatMap((r) => r.options);
    expect(all).toHaveLength(2);
    expect(sortStreams(all)).toHaveLength(1);
  });

  it('a url do addon não vai para o resultado', async () => {
    const res = await run([addon('bad')], (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch);
    expect(JSON.stringify(res.map((r) => ({ o: r.options, d: r.dropped, f: r.failed })))).not.toContain('addon.test');
  });
});
