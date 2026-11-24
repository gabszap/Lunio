import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TAB_PATHS, pushTabUrl, tabFromPath } from '../homeRoute';

describe('homeRoute (/rooms)', () => {
  it('mapeia TAB_PATHS incluindo rooms -> /rooms', () => {
    expect(TAB_PATHS).toEqual({
      catalog: '/catalog',
      room: '/home',
      rooms: '/rooms',
      status: '/status',
    });
  });

  it('resolve /rooms e /rooms/ para a aba rooms', () => {
    expect(tabFromPath('/rooms')).toBe('rooms');
    expect(tabFromPath('/rooms/')).toBe('rooms');
  });

  it('mantém o mapeamento das demais rotas (catalog, status e room)', () => {
    expect(tabFromPath('/catalog')).toBe('catalog');
    expect(tabFromPath('/calendar')).toBe('catalog');
    expect(tabFromPath('/library')).toBe('catalog');
    expect(tabFromPath('/detail/movie/tt1')).toBe('catalog');
    expect(tabFromPath('/discover/movie/pop')).toBe('catalog');

    expect(tabFromPath('/status')).toBe('status');

    expect(tabFromPath('/')).toBe('room');
    expect(tabFromPath('/home')).toBe('room');
    expect(tabFromPath('/desconhecida')).toBe('room');
  });

  describe('pushTabUrl para rooms', () => {
    let current = '/';
    const pushState = vi.fn((_s: unknown, _t: string, url: string) => {
      current = url;
    });

    beforeEach(() => {
      current = '/';
      pushState.mockClear();
      vi.stubGlobal('window', {
        get location() {
          const u = new URL(current, 'https://lunio.test');
          return { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash };
        },
        history: { pushState, replaceState: vi.fn() },
      });
    });

    afterEach(() => vi.unstubAllGlobals());

    it('navega para /rooms limpando parâmetros de catálogo e de sala, sem duplicar no histórico', () => {
      current = '/catalog?search=matrix&room=ABC123';
      pushTabUrl('rooms');
      expect(current).toBe('/rooms');
      expect(pushState).toHaveBeenCalledTimes(1);

      pushTabUrl('rooms');
      expect(pushState).toHaveBeenCalledTimes(1);
    });
  });
});
