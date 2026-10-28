import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detailFromPath, detailPath, readDetailFromUrl, readSearchFromUrl, readSeasonFromUrl, writeDetailToUrl, writeSearchToUrl, writeSeasonToUrl } from './searchUrl';

describe('readSearchFromUrl', () => {
  it('lê a busca (com acento, dois-pontos e espaço, nas duas formas de codificar)', () => {
    expect(readSearchFromUrl('?search=re%3A%20zero')).toBe('re: zero');
    expect(readSearchFromUrl('?search=re%3A+zero')).toBe('re: zero');
    expect(readSearchFromUrl('?search=cora%C3%A7%C3%A3o')).toBe('coração');
  });

  it('sem busca, vazio; ignora os outros parâmetros e limita o tamanho', () => {
    expect(readSearchFromUrl('')).toBe('');
    expect(readSearchFromUrl('?room=ABC12345&t=90')).toBe('');
    expect(readSearchFromUrl(`?search=${'a'.repeat(300)}`)).toHaveLength(100);
  });
});

describe('writeSearchToUrl', () => {
  let current = '/?room=ABC12345';
  const replaceState = vi.fn((_s: unknown, _t: string, url: string) => {
    current = url;
  });

  beforeEach(() => {
    current = '/?room=ABC12345';
    replaceState.mockClear();
    vi.stubGlobal('window', {
      get location() {
        const u = new URL(current, 'https://lunio.test');
        return { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash };
      },
      history: { replaceState },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('grava a busca mantendo os outros parâmetros e a remove ao limpar', () => {
    writeSearchToUrl('re: zero');
    expect(current).toBe('/?room=ABC12345&search=re%3A+zero');
    writeSearchToUrl('   ');
    expect(current).toBe('/?room=ABC12345');
  });

  it('não mexe no histórico quando nada mudou', () => {
    writeSearchToUrl('');
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('título aberto (/detail/<tipo>/<id>)', () => {
  it('lê o caminho, com o id composto codificado como no Stremio', () => {
    expect(detailFromPath('/detail/series/tt5607616')).toEqual({ type: 'series', id: 'tt5607616' });
    expect(detailFromPath('/detail/series/mal%3A31240')).toEqual({ type: 'series', id: 'mal:31240' });
    expect(detailFromPath('/detail/series/mal:31240/')).toEqual({ type: 'series', id: 'mal:31240' });
    expect(detailFromPath('/detail/anime.series/tmdb.123')).toEqual({ type: 'anime.series', id: 'tmdb.123' });
    expect(readDetailFromUrl('?season=2', '/detail/series/tt5607616')).toEqual({ type: 'series', id: 'tt5607616' });
    expect(detailPath({ type: 'series', id: 'mal:31240' })).toBe('/detail/series/mal%3A31240');
  });

  it('caminho inválido não vira título', () => {
    for (const bad of ['/detail', '/detail/series', '/detail/series/', '/detail/Series/tt1', '/detail/series/a%20b', '/detail/series/a/b/c', '/detail/series/a/a%20b', '/detail/../x/tt1', '/detail/series/%E0%A4%A', '/detail/series/a/%E0%A4%A', '/catalog', '/']) {
      expect(detailFromPath(bad), bad).toBeNull();
    }
  });

  it('o episódio é o terceiro segmento (/detail/<tipo>/<id>/<videoId>), com ida e volta', () => {
    expect(detailFromPath('/detail/series/a/b')).toEqual({ type: 'series', id: 'a', videoId: 'b' });
    const ref = { type: 'series', id: 'mal:61469', videoId: 'tt2359704:6:1' };
    expect(detailPath(ref)).toBe('/detail/series/mal%3A61469/tt2359704%3A6%3A1');
    expect(detailFromPath(detailPath(ref))).toEqual(ref);
    expect(detailFromPath('/detail/series/mal%3A61469/tt2359704%3A6%3A1/')).toEqual(ref);
    expect(readDetailFromUrl('?season=6', '/detail/series/mal%3A61469/tt2359704%3A6%3A1')).toEqual(ref);
  });

  it('o id do episódio aceita mais que o do título (+, ids compostos), mas não espaço nem /', () => {
    for (const videoId of ['kitsu:123:1:2', 'ep+1', 'a@b~c']) {
      const ref = { type: 'series', id: 'tt1', videoId };
      expect(detailFromPath(detailPath(ref)), videoId).toEqual(ref);
    }
    expect(detailFromPath('/detail/series/tt1/a%20b')).toBeNull();
    expect(detailFromPath('/detail/series/tt1/a%2Fb')).toBeNull();
  });

  it('o link antigo (?detail=) continua sendo lido, inclusive id composto e codificado', () => {
    expect(readDetailFromUrl('?detail=series/tt5607616')).toEqual({ type: 'series', id: 'tt5607616' });
    expect(readDetailFromUrl('?detail=series/mal:31240')).toEqual({ type: 'series', id: 'mal:31240' });
    expect(readDetailFromUrl('?detail=series%2Fmal%3A31240')).toEqual({ type: 'series', id: 'mal:31240' });
    expect(readDetailFromUrl('?detail=anime.series/mal:1&room=ABC')).toEqual({ type: 'anime.series', id: 'mal:1' });
  });

  it('ignora o que não é tipo/id válido (nada disso vira pedido)', () => {
    for (const bad of ['', '?detail=', '?detail=series', '?detail=/tt1', '?detail=Series/tt1', '?detail=../x/tt1', '?detail=series/a%20b', '?detail=series/a/b', `?detail=series/${'a'.repeat(200)}`]) {
      expect(readDetailFromUrl(bad), bad).toBeNull();
    }
  });

  describe('writeDetailToUrl', () => {
    let current = '/catalog?search=re%3A+zero';
    beforeEach(() => {
      current = '/catalog?search=re%3A+zero';
      vi.stubGlobal('window', {
        get location() {
          const u = new URL(current, 'https://lunio.test');
          return { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash };
        },
        history: { replaceState: (_s: unknown, _t: string, url: string) => (current = url) },
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('o título vira o caminho /detail/<tipo>/<id> (sem a busca) e, ao fechar, volta a /catalog', () => {
      writeDetailToUrl({ type: 'series', id: 'mal:31240' });
      expect(current).toBe('/detail/series/mal%3A31240'); // a busca não vai junto (a aba a restaura ao fechar)
      writeDetailToUrl({ type: 'series', id: 'tt5607616' });
      expect(current).toBe('/detail/series/tt5607616');
      writeDetailToUrl(null);
      expect(current).toBe('/catalog');
    });

    it('grava o episódio no caminho, mantém ?season= e volta ao título (sem o episódio) ou ao catálogo', () => {
      current = '/detail/series/mal%3A61469?season=6';
      writeDetailToUrl({ type: 'series', id: 'mal:61469', videoId: 'tt2359704:6:1' });
      expect(current).toBe('/detail/series/mal%3A61469/tt2359704%3A6%3A1?season=6');
      writeDetailToUrl({ type: 'series', id: 'mal:61469' });
      expect(current).toBe('/detail/series/mal%3A61469?season=6');
      writeDetailToUrl(null);
      expect(current).toBe('/catalog?season=6');
    });

    it('troca o link antigo (?detail=) pelo caminho e não mexe numa rota que não é de título', () => {
      current = '/?detail=series/tt1&room=ABC';
      writeDetailToUrl({ type: 'series', id: 'tt1' });
      expect(current).toBe('/detail/series/tt1?room=ABC');
      current = '/status';
      writeDetailToUrl(null);
      expect(current).toBe('/status');
    });
  });
});

describe('temporada aberta (?season=)', () => {
  it('lê o número (0 = especiais) e ignora o resto', () => {
    expect(readSeasonFromUrl('?season=2')).toBe(2);
    expect(readSeasonFromUrl('?season=0')).toBe(0);
    for (const bad of ['', '?season=', '?season=-1', '?season=a', '?season=1.5', '?season=9999']) expect(readSeasonFromUrl(bad), bad).toBeNull();
  });

  describe('writeSeasonToUrl', () => {
    let current = '/detail/series/mal%3A31240';
    beforeEach(() => {
      current = '/detail/series/mal%3A31240';
      vi.stubGlobal('window', {
        get location() {
          const u = new URL(current, 'https://lunio.test');
          return { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash };
        },
        history: { replaceState: (_s: unknown, _t: string, url: string) => (current = url) },
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('grava a temporada como parâmetro do título (?season=, como no Stremio) e a remove ao fechar', () => {
      writeSeasonToUrl(2);
      expect(current).toBe('/detail/series/mal%3A31240?season=2');
      writeSeasonToUrl(0);
      expect(current).toBe('/detail/series/mal%3A31240?season=0');
      writeSeasonToUrl(null);
      expect(current).toBe('/detail/series/mal%3A31240');
    });
  });
});
