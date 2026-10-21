import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDetailFromUrl, readSearchFromUrl, writeDetailToUrl, writeSearchToUrl } from './searchUrl';

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

describe('título aberto (?detail=)', () => {
  it('lê tipo e id, inclusive id composto e codificado', () => {
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
    let current = '/?search=re%3A+zero';
    beforeEach(() => {
      current = '/?search=re%3A+zero';
      vi.stubGlobal('window', {
        get location() {
          const u = new URL(current, 'https://lunio.test');
          return { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash };
        },
        history: { replaceState: (_s: unknown, _t: string, url: string) => (current = url) },
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('grava legível (/ e : sem codificar), mantém a busca e remove ao fechar', () => {
      writeDetailToUrl({ type: 'series', id: 'mal:31240' });
      expect(current).toBe('/?search=re%3A+zero&detail=series/mal:31240');
      writeDetailToUrl(null);
      expect(current).toBe('/?search=re%3A+zero');
    });
  });
});
