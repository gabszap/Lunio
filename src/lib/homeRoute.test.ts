import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeCatalogUrl, pushTabUrl, tabFromPath } from './homeRoute';

describe('tabFromPath', () => {
  it('/catalog é o catálogo, /status o status, e /, /home e o que não existe são a Sala', () => {
    expect(tabFromPath('/catalog')).toBe('catalog');
    expect(tabFromPath('/catalog/')).toBe('catalog');
    expect(tabFromPath('/status')).toBe('status');
    expect(tabFromPath('/home')).toBe('room');
    expect(tabFromPath('/')).toBe('room');
    expect(tabFromPath('')).toBe('room');
    expect(tabFromPath('/qualquer-coisa')).toBe('room');
  });
});

describe('endereço das abas', () => {
  let current = '/';
  const pushState = vi.fn((_s: unknown, _t: string, url: string) => {
    current = url;
  });
  const replaceState = vi.fn((_s: unknown, _t: string, url: string) => {
    current = url;
  });

  beforeEach(() => {
    current = '/';
    pushState.mockClear();
    replaceState.mockClear();
    vi.stubGlobal('window', {
      get location() {
        const u = new URL(current, 'https://lunio.test');
        return { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash };
      },
      history: { pushState, replaceState },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('trocar de aba empurra a rota; já estando nela, não faz nada (`/` já é a Sala)', () => {
    pushTabUrl('room');
    expect(pushState).not.toHaveBeenCalled();
    pushTabUrl('catalog');
    expect(current).toBe('/catalog');
    pushTabUrl('catalog');
    expect(pushState).toHaveBeenCalledTimes(1);
    pushTabUrl('status');
    expect(current).toBe('/status');
    pushTabUrl('room');
    expect(current).toBe('/home');
  });

  it('sair do catálogo leva embora a busca, o título e a temporada; o link da sala não acompanha o catálogo', () => {
    current = '/catalog?search=re%3A+zero&detail=series/mal:31240&season=2';
    pushTabUrl('room');
    expect(current).toBe('/home');

    current = '/home?room=ABC12345';
    pushTabUrl('catalog');
    expect(current).toBe('/catalog');
    pushTabUrl('status');
    expect(current).toBe('/status');
  });

  it('`/` com busca do catálogo vira /catalog sem criar entrada no histórico', () => {
    current = '/?search=naruto';
    canonicalizeCatalogUrl();
    expect(current).toBe('/catalog?search=naruto');
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(pushState).not.toHaveBeenCalled();
    canonicalizeCatalogUrl();
    expect(replaceState).toHaveBeenCalledTimes(1);
  });
});
