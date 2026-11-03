import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  getWatchedEpisodes,
  isSeriesType,
  mergeGroups,
  parseSeriesContext,
  rowTitles,
  seasonOrder,
  setEpisodesWatched,
  toggleEpisodeWatched,
  type CatalogRow,
  type SearchGroup,
} from './catalog';
import { t } from './i18n';

const row = (type: string, id: string, name: string): CatalogRow => ({ type, id, name, genres: [] });

describe('rowTitles', () => {
  it('nomes únicos ficam como estão', () => {
    expect(rowTitles([row('movie', 'a', 'Filmes populares'), row('series', 'b', 'Séries em alta')])).toEqual(['Filmes populares', 'Séries em alta']);
  });

  it('o mesmo nome em tipos diferentes ganha o tipo, para as fileiras se distinguirem', () => {
    // O rótulo do tipo segue o idioma do navegador (o CI roda em inglês): compara com a mesma tradução
    expect(rowTitles([row('movie', 'top', 'Popular'), row('series', 'top', 'Popular'), row('anime', 'x', 'Popular'), row('movie', 'y', 'Outra')])).toEqual([
      `Popular · ${t('Filmes')}`,
      `Popular · ${t('Séries')}`,
      `Popular · ${t('Animes')}`,
      'Outra',
    ]);
  });
});

describe('seasonOrder', () => {
  it('1, 2, 3… e os especiais (temporada 0) no fim, sem repetir', () => {
    expect(seasonOrder([0, 2, 1, 2, 3, 0])).toEqual([1, 2, 3, 0]);
    expect(seasonOrder([0])).toEqual([0]);
    expect(seasonOrder([])).toEqual([]);
  });
});

describe('isSeriesType', () => {
  it('anime e qualquer tipo que não seja filme contam como série', () => {
    expect(isSeriesType('movie')).toBe(false);
    expect(isSeriesType('series')).toBe(true);
    expect(isSeriesType('anime')).toBe(true);
  });
});

describe('mergeGroups (busca unificada)', () => {
  const group = (id: string, metas: Array<{ id: string; name: string; imdbId?: string; year?: string }>): SearchGroup => ({
    type: 'series',
    id,
    name: id,
    metas: metas.map((m) => ({ type: 'series', ...m })),
  });

  it('junta os grupos na ordem e tira o mesmo título (mesmo IMDb, ou mesmo nome e ano)', () => {
    const merged = mergeGroups([
      group('anime', [
        { id: 'mal:1', name: 'Re:ZERO', imdbId: 'tt1', year: '2016' },
        { id: 'mal:2', name: 'Re:ZERO Season 2', imdbId: 'tt1', year: '2020' }, // mesmo IMDb: some
      ]),
      group('series', [
        { id: 'tt1', name: 'Re:ZERO', imdbId: 'tt1' }, // já veio do anime
        { id: 'tt2', name: 'Outra', year: '2019' },
        { id: 'tvdb:9', name: 'outra', year: '2019' }, // mesmo nome e ano, sem IMDb: some
      ]),
    ]);
    expect(merged.map((m) => m.id)).toEqual(['mal:1', 'tt2']);
  });

  it('sem grupos, vazio', () => {
    expect(mergeGroups([])).toEqual([]);
  });
});

describe('episódios assistidos', () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
    });
  });

  it('episódio começa como não assistido', () => {
    expect(getWatchedEpisodes().has('ep1')).toBe(false);
  });

  it('toggleEpisodeWatched alterna entre assistido e não assistido', () => {
    expect(toggleEpisodeWatched('ep1')).toBe(true);
    expect(getWatchedEpisodes().has('ep1')).toBe(true);

    expect(toggleEpisodeWatched('ep1')).toBe(false);
    expect(getWatchedEpisodes().has('ep1')).toBe(false);
  });

  it('setEpisodesWatched define múltiplos episódios de uma vez', () => {
    setEpisodesWatched(['ep1', 'ep2', 'ep3'], true);
    expect([...getWatchedEpisodes()].sort()).toEqual(['ep1', 'ep2', 'ep3']);

    setEpisodesWatched(['ep1', 'ep3'], false);
    expect([...getWatchedEpisodes()]).toEqual(['ep2']);
  });
});

describe('parseSeriesContext', () => {
  const valid = {
    seriesId: 'tt1',
    seriesTitle: 'Série',
    seriesType: 'series',
    currentEpisodeId: 'tt1:1:2',
    season: 1,
    episode: 2,
    episodes: [
      { id: 'tt1:1:1', season: 1, episode: 1, title: 'Primeiro' },
      { id: 'tt1:1:2', season: 1, episode: 2, title: 'Segundo', thumbnail: 'https://x.test/a.jpg' },
    ],
  };

  it('aceita um contexto completo', () => {
    expect(parseSeriesContext(valid)).toMatchObject({ seriesId: 'tt1', currentEpisodeId: 'tt1:1:2', episodes: [{ id: 'tt1:1:1' }, { id: 'tt1:1:2', thumbnail: 'https://x.test/a.jpg' }] });
  });

  it('forma errada (versão antiga, cortado, não é objeto) vira null em vez de derrubar o player', () => {
    for (const bad of [null, undefined, 'x', 7, [], {}, { ...valid, episodes: undefined }, { ...valid, episodes: 'x' }, { ...valid, season: 'um' }, { ...valid, currentEpisodeId: 3 }]) {
      expect(parseSeriesContext(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('descarta só os episódios inválidos e completa o título que falta', () => {
    const ctx = parseSeriesContext({ ...valid, episodes: [valid.episodes[0], null, { id: '', season: 1, episode: 1 }, { id: 'x', season: 'a', episode: 1 }, { id: 'tt1:1:3', season: 1, episode: 3 }] });
    expect(ctx?.episodes.map((e) => e.id)).toEqual(['tt1:1:1', 'tt1:1:3']);
    expect(ctx?.episodes[1].title).toBe('');
  });
});
