import { describe, expect, it } from 'vitest';
import { isSeriesType, rowTitles, seasonOrder, type CatalogRow } from './catalog';

const row = (type: string, id: string, name: string): CatalogRow => ({ type, id, name, genres: [] });

describe('rowTitles', () => {
  it('nomes únicos ficam como estão', () => {
    expect(rowTitles([row('movie', 'a', 'Filmes populares'), row('series', 'b', 'Séries em alta')])).toEqual(['Filmes populares', 'Séries em alta']);
  });

  it('o mesmo nome em tipos diferentes ganha o tipo, para as fileiras se distinguirem', () => {
    expect(rowTitles([row('movie', 'top', 'Popular'), row('series', 'top', 'Popular'), row('anime', 'x', 'Popular'), row('movie', 'y', 'Outra')])).toEqual([
      'Popular · Filmes',
      'Popular · Séries',
      'Popular · Animes',
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
