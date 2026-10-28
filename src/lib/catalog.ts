import React, { useEffect, useState } from 'react';
import { t, msg } from './i18n';
import { apiFetch } from './access';
import type { CatalogSeriesContext } from '../types/media';
/**
 * Catálogo de filmes e séries. Quem fala com a fonte (um addon do Stremio configurado em `CATALOG_URL`) é o servidor
 * (`/api/catalog/*`, com cache); aqui só se consome o que ele devolve. Só metadados: pôster, sinopse, temporadas e
 * episódios. O vídeo em si continua vindo de um link de stream, arquivo, Drive ou YouTube que a pessoa escolhe.
 */

/** `movie`, `series`, `anime`… conforme a fonte; `anime` é tratado como série (o Stremio também). */
export type CatalogType = string;

export const isSeriesType = (type: CatalogType) => type !== 'movie';

export interface CatalogItem {
  /** Id na fonte (`tt…`, `tmdb:…`, `mal:…`): é o que vale para pedir o detalhe. */
  id: string;
  imdbId?: string;
  type: CatalogType;
  name: string;
  poster?: string;
  year?: string;
}

export interface CatalogEpisode {
  id: string;
  season: number;
  episode: number;
  title: string;
  overview?: string;
  thumbnail?: string;
  released?: string;
}

export interface CatalogMeta extends CatalogItem {
  description?: string;
  genres: string[];
  runtime?: string;
  background?: string;
  imdbRating?: string;
  /** Id do anime no MyAnimeList (para o link da página dele). */
  malId?: string;
  /** Nota (0–10) no MyAnimeList, votos e posição no ranking (ausentes se a API do MAL não respondeu). */
  malScore?: number;
  malScoredBy?: number;
  malRank?: number;
  /** Capas de cada temporada (da fonte, ex.: AIOMetadata app_extras.seasonPosters). */
  seasonPosters?: Record<string, string>;
  /** Ids do anime no MyAnimeList para cada temporada ("1": "14719", "2": "20899"...). */
  seasonMalIds?: Record<string, string>;
  /** Notas já conhecidas no cache para cada temporada. */
  seasonMalScores?: Record<string, { score: number; scoredBy?: number; rank?: number; malId: string }>;
  /** A temporada 0 são os especiais. */
  episodes: CatalogEpisode[];
}

export interface CatalogRow {
  type: CatalogType;
  id: string;
  name: string;
  genres: string[];
  /** A fileira exige um gênero e só tem um: ele vai no pedido. */
  fixedGenre?: string;
}

/** Resultado da busca em um catálogo de busca da fonte ("Anime Series Search", "Movies Search"…). */
export interface SearchGroup {
  type: CatalogType;
  id: string;
  name: string;
  metas: CatalogItem[];
}

/** Um catálogo da tela Explorar (o Descobrir do Stremio). */
export interface DiscoverEntry {
  type: CatalogType;
  id: string;
  name: string;
  genres: string[];
  /** Só responde com um gênero escolhido (sem "nenhum"). */
  genreRequired: boolean;
  /** Aceita `skip`: dá para carregar mais ao rolar. */
  paged: boolean;
}

export interface CatalogManifest {
  name: string;
  rows: CatalogRow[];
  /** Catálogos navegáveis no Explorar (falta em respostas de servidor antigo). */
  discover?: DiscoverEntry[];
  isDefault: boolean;
  /** A fonte está fora do ar e o servidor devolveu a última resposta guardada. */
  stale: boolean;
}

const cache = new Map<string, Promise<any>>();

/** GET em `/api/catalog/...`; respostas iguais são reaproveitadas (e uma falha não fica guardada). */
function getJson<T>(path: string): Promise<T> {
  let p = cache.get(path);
  if (!p) {
    p = apiFetch(`/api/catalog/${path}`).then((r) => {
      if (!r.ok) throw new Error(`Catálogo ${r.status}`);
      return r.json();
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p as Promise<T>;
}

export function fetchManifest(): Promise<CatalogManifest> {
  return getJson<CatalogManifest>('manifest');
}

export async function fetchRow(row: Pick<CatalogRow, 'type' | 'id'> & { fixedGenre?: string }, genre?: string, skip = 0): Promise<CatalogItem[]> {
  const q = new URLSearchParams({ type: row.type, id: row.id });
  const g = genre ?? (row as CatalogRow).fixedGenre;
  if (g) q.set('genre', g);
  if (skip > 0) q.set('skip', String(skip));
  const data = await getJson<{ metas: CatalogItem[] }>(`row?${q}`);
  return data.metas || [];
}

/** Um grupo por catálogo de busca da fonte, como no Stremio (grupos sem resultado nem chegam). */
export async function searchCatalog(query: string): Promise<SearchGroup[]> {
  const data = await getJson<{ groups: SearchGroup[] }>(`search?${new URLSearchParams({ q: query.trim() })}`);
  return data.groups || [];
}

export interface MalScore {
  /** Nota 0–10 (null: sem nota ainda, ou a API do MAL não respondeu: ver `failed`). */
  score: number | null;
  scoredBy?: number;
  rank?: number;
  failed: boolean;
}

const malScores = new Map<string, MalScore>();

/** Nota do anime no MyAnimeList. O servidor já tenta 3 vezes; só respostas boas ficam guardadas aqui. */
export async function fetchMalScore(malId: string): Promise<MalScore> {
  const cached = malScores.get(malId);
  if (cached) return cached;
  const res = await apiFetch(`/api/catalog/malscore?${new URLSearchParams({ id: malId })}`);
  if (!res.ok) throw new Error(`Catálogo ${res.status}`);
  const body = (await res.json()) as MalScore;
  if (!body.failed) malScores.set(malId, body);
  return body;
}

export async function fetchMeta(type: CatalogType, id: string): Promise<CatalogMeta> {
  const data = await getJson<{ meta: CatalogMeta }>(`meta?${new URLSearchParams({ type, id })}`);
  return data.meta;
}

/**
 * Busca unificada (a antiga): os grupos num só, na ordem dos catálogos, sem repetir o mesmo título (mesmo IMDb, ou mesmo
 * nome e ano). O primeiro que aparece fica; as temporadas de um anime com o mesmo IMDb viram um item só.
 */
export function mergeGroups(groups: SearchGroup[]): CatalogItem[] {
  const seen = new Set<string>();
  const merged: CatalogItem[] = [];
  for (const group of groups) {
    for (const item of group.metas) {
      const key = item.imdbId || `${item.name.toLowerCase()}|${item.year ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

/** Fileiras com o mesmo nome (ex.: "Popular" de filmes e de séries) ganham o tipo no título para se distinguirem. */
export function rowTitles(rows: Array<{ name: string; type: CatalogType }>): string[] {
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.name, (count.get(r.name) || 0) + 1);
  const typeLabel = (type: string) => (type === 'movie' ? t('Filmes') : type === 'series' ? t('Séries') : type === 'anime' ? t('Animes') : type);
  return rows.map((r) => ((count.get(r.name) || 0) > 1 ? `${r.name} · ${typeLabel(r.type)}` : r.name));
}

/** Temporadas na ordem de exibição: 1, 2, 3… e os especiais (temporada 0) no fim. */
export function seasonOrder(seasons: number[]): number[] {
  const unique = Array.from(new Set(seasons));
  return [...unique.filter((s) => s >= 1).sort((a, b) => a - b), ...unique.filter((s) => s < 1)];
}

// ───────────── Minha lista (local) ─────────────

const LIST_KEY = 'lunio_my_list';

export function getMyList(): CatalogItem[] {
  try {
    return JSON.parse(localStorage.getItem(LIST_KEY) || '[]');
  } catch {
    return [];
  }
}

export function isInMyList(id: string): boolean {
  return getMyList().some((i) => i.id === id);
}

export function toggleMyList(item: CatalogItem): boolean {
  const list = getMyList();
  const exists = list.some((i) => i.id === item.id);
  const next = exists ? list.filter((i) => i.id !== item.id) : [{ id: item.id, type: item.type, name: item.name, poster: item.poster, year: item.year }, ...list];
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(next.slice(0, 60)));
  } catch {
    // armazenamento indisponível
  }
  return !exists;
}

export const GENRES_PT: Record<string, string> = {
  Action: msg('Ação'),
  Adventure: 'Aventura',
  Animation: msg('Animação'),
  Comedy: msg('Comédia'),
  Crime: 'Crime',
  Documentary: msg('Documentário'),
  Drama: 'Drama',
  Family: msg('Família'),
  Fantasy: 'Fantasia',
  History: msg('História'),
  Horror: 'Terror',
  Mystery: msg('Mistério'),
  Romance: 'Romance',
  'Sci-Fi': msg('Ficção científica'),
  Thriller: 'Suspense',
  War: 'Guerra',
  Western: 'Faroeste',
};

export const episodeTag = (season: number, episode: number) =>
  `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

// ───────────── Episódios assistidos (local) ─────────────

const WATCHED_EPISODES_KEY = 'lunio_watched_episodes';
const WATCHED_CHANGE_EVENT = 'lunio:watched-episodes-changed';

export function getWatchedEpisodes(): Set<string> {
  try {
    const raw = localStorage.getItem(WATCHED_EPISODES_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

/** Marca (ou desmarca) vários episódios de uma vez e avisa as telas abertas. */
export function setEpisodesWatched(episodeIds: string[], isWatched: boolean): void {
  const watched = getWatchedEpisodes();
  for (const id of episodeIds) {
    if (isWatched) watched.add(id);
    else watched.delete(id);
  }
  try {
    localStorage.setItem(WATCHED_EPISODES_KEY, JSON.stringify(Array.from(watched)));
    window.dispatchEvent(new CustomEvent(WATCHED_CHANGE_EVENT));
  } catch {
    // armazenamento indisponível
  }
}

/** Alterna um episódio e devolve o novo estado (`true` = assistido). */
export function toggleEpisodeWatched(episodeId: string): boolean {
  const next = !getWatchedEpisodes().has(episodeId);
  setEpisodesWatched([episodeId], next);
  return next;
}

export function useWatchedEpisodes() {
  const [watched, setWatched] = useState<Set<string>>(() => getWatchedEpisodes());

  useEffect(() => {
    const onUpdate = () => setWatched(getWatchedEpisodes());
    window.addEventListener(WATCHED_CHANGE_EVENT, onUpdate);
    window.addEventListener('storage', onUpdate);
    return () => {
      window.removeEventListener(WATCHED_CHANGE_EVENT, onUpdate);
      window.removeEventListener('storage', onUpdate);
    };
  }, []);

  return {
    isWatched: (id: string) => watched.has(id),
    toggleWatched: (id: string) => toggleEpisodeWatched(id),
    setEpisodesWatched: (ids: string[], isWatched: boolean) => setEpisodesWatched(ids, isWatched),
  };
}

const ACTIVE_SERIES_CONTEXT_KEY = 'lunio_active_series_context';

export function saveActiveSeriesContext(ctx: CatalogSeriesContext | null): void {
  try {
    if (ctx) sessionStorage.setItem(ACTIVE_SERIES_CONTEXT_KEY, JSON.stringify(ctx));
    else sessionStorage.removeItem(ACTIVE_SERIES_CONTEXT_KEY);
  } catch {
    // sessionStorage indisponível
  }
}

/** Confere o que veio do `sessionStorage` (pode ser de uma versão antiga ou estar cortado): forma errada vira `null`, episódio inválido é descartado. */
export function parseSeriesContext(value: unknown): CatalogSeriesContext | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === 'string' ? x : null);
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const seriesId = text(v.seriesId);
  const seriesTitle = text(v.seriesTitle);
  const seriesType = text(v.seriesType);
  const currentEpisodeId = text(v.currentEpisodeId);
  const season = num(v.season);
  const episode = num(v.episode);
  if (seriesId === null || seriesTitle === null || seriesType === null || currentEpisodeId === null || season === null || episode === null) return null;
  if (!Array.isArray(v.episodes)) return null;
  const episodes: CatalogSeriesContext['episodes'] = [];
  for (const raw of v.episodes) {
    const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = text(e.id);
    const s = num(e.season);
    const n = num(e.episode);
    if (!id || s === null || n === null) continue;
    episodes.push({
      id,
      season: s,
      episode: n,
      title: text(e.title) ?? '',
      overview: text(e.overview) ?? undefined,
      thumbnail: text(e.thumbnail) ?? undefined,
      released: text(e.released) ?? undefined,
    });
  }
  return { seriesId, seriesTitle, seriesType, currentEpisodeId, season, episode, episodes };
}

export function loadActiveSeriesContext(): CatalogSeriesContext | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_SERIES_CONTEXT_KEY);
    return raw ? parseSeriesContext(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
