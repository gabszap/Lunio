import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSearchFromUrl, writeSearchToUrl } from './searchUrl';

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
