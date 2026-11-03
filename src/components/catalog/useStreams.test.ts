import { describe, expect, it } from 'vitest';
import { reduceStreams, targetKeyOf, type StreamsState } from './useStreams';
import type { SourceResult, StreamOption } from '../../lib/streams';

const opt = (url: string, level: StreamOption['level']): StreamOption => ({
  key: url,
  sourceId: 'a',
  sourceName: 'A',
  title: url,
  description: '',
  url,
  codecs: { video: null, audio: [], dolbyVision: false } as unknown as StreamOption['codecs'],
  level,
  reasons: [],
});

const result = (options: StreamOption[], extra: Partial<SourceResult> = {}): SourceResult => ({
  addon: { id: 'a', name: 'A' },
  options,
  dropped: 0,
  failed: false,
  ...extra,
});

const initial: StreamsState = { status: 'loading', options: [], failedSources: 0, dropped: 0, pending: 2 };

describe('reduceStreams', () => {
  it('ordena por nível e decrementa pending', () => {
    const s = reduceStreams(initial, result([opt('u1', 'maybe'), opt('u2', 'ok')]));
    expect(s.options.map((o) => o.url)).toEqual(['u2', 'u1']);
    expect(s.pending).toBe(1);
    expect(s.status).toBe('loading');
  });

  it('conta fonte que falhou e termina quando pending zera', () => {
    const s = reduceStreams({ ...initial, pending: 1 }, result([], { failed: true }));
    expect(s.failedSources).toBe(1);
    expect(s.pending).toBe(0);
    expect(s.status).toBe('done');
  });

  it('soma os descartados', () => {
    const s = reduceStreams(initial, result([], { dropped: 3 }));
    expect(s.dropped).toBe(3);
  });

  it('a mesma url em dois resultados aparece uma vez', () => {
    const a = reduceStreams(initial, result([opt('u1', 'ok')]));
    const b = reduceStreams(a, result([opt('u1', 'ok')]));
    expect(b.options).toHaveLength(1);
  });
});

describe('targetKeyOf', () => {
  it('é igual para o mesmo conteúdo em objetos diferentes', () => {
    expect(targetKeyOf({ type: 'series', videoId: 'x:1:2', season: 1, episode: 2 })).toBe(
      targetKeyOf({ type: 'series', videoId: 'x:1:2', season: 1, episode: 2 }),
    );
  });
  it('muda com o videoId, o tipo e o episódio', () => {
    const base = targetKeyOf({ type: 'series', videoId: 'a', season: 1, episode: 1 });
    expect(targetKeyOf({ type: 'series', videoId: 'b', season: 1, episode: 1 })).not.toBe(base);
    expect(targetKeyOf({ type: 'anime', videoId: 'a', season: 1, episode: 1 })).not.toBe(base);
    expect(targetKeyOf({ type: 'series', videoId: 'a', season: 1, episode: 2 })).not.toBe(base);
    expect(targetKeyOf(null)).toBe('');
  });
});
