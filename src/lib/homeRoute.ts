import type { HomeTab } from '../components/home/HomeLayout';
import { detailPath, readDetailFromUrl } from './searchUrl';

/**
 * Rotas da Home: `/catalog` (Catálogo), `/home` (Sala) e `/status` (Status); `/detail/<tipo>/<id>` é um título aberto no Catálogo. A raiz `/` continua sendo a Sala (os links de
 * sala `/?room=ABC` seguem valendo). Trocar de aba empurra a rota no histórico (o Voltar do navegador volta à aba anterior);
 * a busca, o título e a temporada do catálogo são parâmetros desta rota e saem dela quando se sai do catálogo.
 */

export const TAB_PATHS: Record<HomeTab, string> = { catalog: '/catalog', room: '/home', status: '/status' };

/** Aba de um caminho; `/`, `/home` e qualquer rota desconhecida são a Sala. */
export function tabFromPath(pathname: string): HomeTab {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === TAB_PATHS.catalog || p.startsWith('/detail/')) return 'catalog';
  if (p === TAB_PATHS.status) return 'status';
  return 'room';
}

/** Parâmetros que só fazem sentido no catálogo. */
const CATALOG_PARAMS = ['search', 'detail', 'season'];

/** Leva o endereço para a rota da aba (entrada nova no histórico). Já estando nela, não faz nada. */
export function pushTabUrl(tab: HomeTab) {
  if (typeof window === 'undefined') return;
  if (tabFromPath(window.location.pathname) === tab) return;
  const url = new URL(window.location.href);
  url.pathname = TAB_PATHS[tab];
  if (tab !== 'catalog') for (const k of CATALOG_PARAMS) url.searchParams.delete(k);
  if (tab !== 'room') url.searchParams.delete('room'); // um link de sala não acompanha o catálogo nem o status
  window.history.pushState(null, '', url.pathname + url.search + url.hash);
}

/**
 * `/` com busca ou título do catálogo no endereço é o catálogo: acerta a rota sem criar entrada no histórico. O link antigo
 * `/?detail=series/tt1` vira `/detail/series/tt1`.
 */
export function canonicalizeCatalogUrl() {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const legacy = readDetailFromUrl(url.search, '/'); // só a forma antiga (?detail=)
  if (tabFromPath(url.pathname) === 'catalog' && !legacy) return;
  if (legacy) {
    url.searchParams.delete('detail');
    url.pathname = detailPath(legacy);
  } else {
    url.pathname = TAB_PATHS.catalog;
  }
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}
