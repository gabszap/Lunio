/**
 * A busca e o título aberto no catálogo vão para o endereço, como no Stremio: `/?search=re%3A+zero` e
 * `/?detail=series/mal:31240` (tipo e id da fonte). Dá para compartilhar, recarregar e voltar. Convivem com os outros
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

/** `?detail=<tipo>/<id>` (ex.: `series/tt5607616`, `series/mal:31240`); valor inválido é ignorado. */
export function readDetailFromUrl(search = typeof window === 'undefined' ? '' : window.location.search): DetailRef | null {
  const raw = new URLSearchParams(search).get(DETAIL) ?? '';
  const slash = raw.indexOf('/');
  if (slash < 1) return null;
  const type = raw.slice(0, slash);
  const id = raw.slice(slash + 1);
  return DETAIL_TYPE.test(type) && DETAIL_ID.test(id) ? { type, id } : null;
}

/** Grava (ou, nulo, remove) o título aberto; `/` e `:` ficam legíveis, como no Stremio. */
export function writeDetailToUrl(ref: DetailRef | null) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (ref) url.searchParams.set(DETAIL, `${ref.type}/${ref.id}`);
  else url.searchParams.delete(DETAIL);
  const search = url.search.replace(/(detail=)([^&]*)/, (_m, k: string, v: string) => k + v.replace(/%2F/gi, '/').replace(/%3A/gi, ':'));
  const next = url.pathname + search + url.hash;
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
  const next = url.pathname + url.search.replace(/(detail=)([^&]*)/, (_m, k: string, v: string) => k + v.replace(/%2F/gi, '/').replace(/%3A/gi, ':')) + url.hash;
  if (next !== window.location.pathname + window.location.search + window.location.hash) window.history.replaceState(null, '', next);
}
