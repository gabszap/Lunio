/**
 * A busca do catálogo vai para o endereço (`/?search=re%3A+zero`), como no Stremio: dá para compartilhar, recarregar e
 * voltar para ela. O `search` convive com os outros parâmetros (`room`, `t`…) e some quando a busca é limpa ou a aba muda.
 */

const PARAM = 'search';

export function readSearchFromUrl(search = typeof window === 'undefined' ? '' : window.location.search): string {
  return (new URLSearchParams(search).get(PARAM) ?? '').trim().slice(0, 100);
}

/** Grava (ou, vazio, remove) a busca no endereço sem criar entrada no histórico. */
export function writeSearchToUrl(query: string) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const q = query.trim().slice(0, 100);
  if (q) url.searchParams.set(PARAM, q);
  else url.searchParams.delete(PARAM);
  const next = url.pathname + url.search + url.hash;
  if (next !== window.location.pathname + window.location.search + window.location.hash) window.history.replaceState(null, '', next);
}
