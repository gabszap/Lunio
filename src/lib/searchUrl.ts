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
// O id do episódio vem do addon e pode ter `+` e afins; só o que quebraria o caminho fica de fora
const VIDEO_ID = /^[^\s/?#]{1,200}$/;

export interface DetailRef {
  type: string;
  id: string;
  /** Episódio aberto (o `videos[].id` do meta): `/detail/series/<id>/<videoId>`, como no Stremio. */
  videoId?: string;
}

/** O caminho do título: `/detail/series/tt5607616`, `/detail/series/mal%3A31240`; com episódio, `…/tt2359704%3A6%3A1`. */
export function detailPath(ref: DetailRef): string {
  const base = `/detail/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}`;
  return ref.videoId ? `${base}/${encodeURIComponent(ref.videoId)}` : base;
}

function validDetail(type: string, id: string, videoId?: string): DetailRef | null {
  if (!DETAIL_TYPE.test(type) || !DETAIL_ID.test(id)) return null;
  if (videoId === undefined) return { type, id };
  return VIDEO_ID.test(videoId) ? { type, id, videoId } : null;
}

/** Tipo, id e (opcional) episódio do caminho `/detail/<tipo>/<id>[/<videoId>]`; qualquer outra coisa é null. */
export function detailFromPath(pathname: string): DetailRef | null {
  const m = /^\/detail\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return validDetail(decodeURIComponent(m[1]), decodeURIComponent(m[2]), m[3] === undefined ? undefined : decodeURIComponent(m[3]));
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

/**
 * Grava (ou, nulo, tira) o título aberto: o caminho vira `/detail/<tipo>/<id>` (ou volta a `/catalog`). A rota do título não
 * leva a busca (`?search=`), como no Stremio: quem a restaura ao fechar é a aba do catálogo.
 */
export function writeDetailToUrl(ref: DetailRef | null) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete(DETAIL); // a forma antiga, `?detail=`, deixa de existir
  if (ref) {
    url.pathname = detailPath(ref);
    url.searchParams.delete(PARAM);
  } else if (detailFromPath(url.pathname)) {
    url.pathname = '/catalog';
  }
  const next = url.pathname + url.search + url.hash;
  if (next !== window.location.pathname + window.location.search + window.location.hash) window.history.replaceState(null, '', next);
}

// ───────────── Explorar (Descobrir) ─────────────

export interface DiscoverRef {
  type: string;
  id: string;
  genre?: string;
}

/** `/discover/series/streaming.cru_series?genre=A%C3%A7%C3%A3o`, como o Descobrir do Stremio. */
export function discoverPath(ref: DiscoverRef): string {
  return `/discover/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}`;
}

/** Tipo, catálogo e gênero do endereço `/discover/<tipo>/<catálogo>[?genre=]`; qualquer outra coisa é null. */
export function discoverFromUrl(
  pathname = typeof window === 'undefined' ? '' : window.location.pathname,
  search = typeof window === 'undefined' ? '' : window.location.search
): DiscoverRef | null {
  const m = /^\/discover\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  try {
    const type = decodeURIComponent(m[1]);
    const id = decodeURIComponent(m[2]);
    if (!DETAIL_TYPE.test(type) || !DETAIL_ID.test(id)) return null;
    const genre = (new URLSearchParams(search).get(GENRE) ?? '').trim().slice(0, 60);
    return genre ? { type, id, genre } : { type, id };
  } catch {
    return null;
  }
}

const GENRE = 'genre';

/** Grava o Explorar no endereço (ou, nulo, volta a `/catalog`) sem criar entrada no histórico. */
export function writeDiscoverToUrl(ref: DiscoverRef | null) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (ref) {
    url.pathname = discoverPath(ref);
    url.searchParams.delete(PARAM);
    url.searchParams.delete(DETAIL);
    if (ref.genre) url.searchParams.set(GENRE, ref.genre.slice(0, 60));
    else url.searchParams.delete(GENRE);
  } else if (/^\/discover\//.test(url.pathname)) {
    url.pathname = '/catalog';
    url.searchParams.delete(GENRE);
  }
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
