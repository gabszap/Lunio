import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  getWatchedEpisodes,
  isEpisodeWatched,
  isSeriesType,
  mergeGroups,
  rowTitles,
  seasonOrder,
  setEpisodeWatched,
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
    expect(isEpisodeWatched('ep1')).toBe(false);
  });

  it('toggleEpisodeWatched alterna entre assistido e não assistido', () => {
    expect(toggleEpisodeWatched('ep1')).toBe(true);
    expect(isEpisodeWatched('ep1')).toBe(true);
    expect(getWatchedEpisodes().has('ep1')).toBe(true);

    expect(toggleEpisodeWatched('ep1')).toBe(false);
    expect(isEpisodeWatched('ep1')).toBe(false);
    expect(getWatchedEpisodes().has('ep1')).toBe(false);
  });

  it('setEpisodeWatched define explicitamente o estado', () => {
    setEpisodeWatched('ep2', true);
    expect(isEpisodeWatched('ep2')).toBe(true);

    setEpisodeWatched('ep2', false);
    expect(isEpisodeWatched('ep2')).toBe(false);
  });

  it('setEpisodesWatched define múltiplos episódios de uma vez', () => {
    setEpisodesWatched(['ep1', 'ep2', 'ep3'], true);
    expect(isEpisodeWatched('ep1')).toBe(true);
    expect(isEpisodeWatched('ep2')).toBe(true);
    expect(isEpisodeWatched('ep3')).toBe(true);

    setEpisodesWatched(['ep1', 'ep3'], false);
    expect(isEpisodeWatched('ep1')).toBe(false);
    expect(isEpisodeWatched('ep2')).toBe(true);
    expect(isEpisodeWatched('ep3')).toBe(false);
  });
});
