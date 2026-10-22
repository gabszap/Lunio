/**
 * A busca e o título aberto no catálogo vão para o endereço, como no Stremio: `/catalog?search=re%3A+zero` e
 * `/detail/series/mal%3A31240` (tipo e id da fonte). Dá para compartilhar, recarregar e voltar. Convivem com os outros
 * parâmetros (`room`, `t`…) e somem quando a busca é limpa, o título fechado ou a aba muda.
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

// ───────────── título aberto ─────────────

const DETAIL = 'detail';
const DETAIL_TYPE = /^[a-z][a-z0-9_.-]{1,29}$/;
const DETAIL_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

export interface DetailRef {
  type: string;
  id: string;
}

/** O caminho do título: `/detail/series/tt5607616`, `/detail/series/mal%3A31240` (como no Stremio). */
export function detailPath(ref: DetailRef): string {
  return `/detail/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}`;
}

function validDetail(type: string, id: string): DetailRef | null {
  return DETAIL_TYPE.test(type) && DETAIL_ID.test(id) ? { type, id } : null;
}

/** Tipo e id do caminho `/detail/<tipo>/<id>`; qualquer outra coisa é null. */
export function detailFromPath(pathname: string): DetailRef | null {
  const m = /^\/detail\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return validDetail(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  } catch {
    return null;
  }
}

/**
 * O título aberto, do caminho `/detail/<tipo>/<id>` ou, nos links antigos, de `?detail=<tipo>/<id>`; valor inválido é
 * ignorado.
 */
export function readDetailFromUrl(
  search = typeof window === 'undefined' ? '' : window.location.search,
  pathname = typeof window === 'undefined' ? '' : window.location.pathname
): DetailRef | null {
  const fromPath = detailFromPath(pathname);
  if (fromPath) return fromPath;
  const raw = new URLSearchParams(search).get(DETAIL) ?? '';
  const slash = raw.indexOf('/');
  return slash < 1 ? null : validDetail(raw.slice(0, slash), raw.slice(slash + 1));
}

/** Grava (ou, nulo, tira) o título aberto: o caminho vira `/detail/<tipo>/<id>` (ou volta a `/catalog`). */
export function writeDetailToUrl(ref: DetailRef | null) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete(DETAIL); // a forma antiga, `?detail=`, deixa de existir
  if (ref) url.pathname = detailPath(ref);
  else if (detailFromPath(url.pathname)) url.pathname = '/catalog';
  const next = url.pathname + url.search + url.hash;
  if (next !== window.location.pathname + window.location.search + window.location.hash) window.history.replaceState(null, '', next);
}

// ───────────── temporada aberta ─────────────

const SEASON = 'season';

/** `?season=2` (0 = especiais), como no Stremio; qualquer outra coisa é ignorada. */
export function readSeasonFromUrl(search = typeof window === 'undefined' ? '' : window.location.search): number | null {
  const raw = new URLSearchParams(search).get(SEASON) ?? '';
  return /^\d{1,3}$/.test(raw) ? Number(raw) : null;
}

export function writeSeasonToUrl(season: number | null) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (season === null) url.searchParams.delete(SEASON);
  else url.searchParams.set(SEASON, String(season));
  const next = url.pathname + url.search + url.hash;
  if (next !== window.location.pathname + window.location.search + window.location.hash) window.history.replaceState(null, '', next);
}
