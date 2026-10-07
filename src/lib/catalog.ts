import { t, msg } from './/i18n';
/**
 * Catálogo de filmes e séries via Cinemeta (addon público de metadados do Stremio).
 * Só metadados: pôster, sinopse, temporadas e episódios. O vídeo em si continua vindo
 * de um link de stream, arquivo, Drive ou YouTube que a pessoa escolhe.
 */

const BASE = 'https://v3-cinemeta.strem.io';

export type CatalogType = 'movie' | 'series';

export interface CatalogItem {
  id: string;
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
  episodes: CatalogEpisode[];
}

const cache = new Map<string, Promise<any>>();

function getJson<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Cinemeta ${r.status}`);
      return r.json();
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p as Promise<T>;
}

function toItem(m: any, fallbackType: CatalogType): CatalogItem {
  return {
    id: m.imdb_id || m.id,
    type: m.type === 'series' ? 'series' : m.type === 'movie' ? 'movie' : fallbackType,
    name: m.name,
    poster: m.poster,
    year: String(m.releaseInfo || m.year || '').replace(/[–�]/g, '–') || undefined,
  };
}

export async function fetchTop(type: CatalogType, genre?: string): Promise<CatalogItem[]> {
  const extra = genre ? `/genre=${encodeURIComponent(genre)}` : '';
  const data = await getJson<{ metas: any[] }>(`/catalog/${type}/top${extra}.json`);
  return (data.metas || []).filter((m) => m?.name).map((m) => toItem(m, type));
}

export async function searchCatalog(query: string): Promise<CatalogItem[]> {
  const q = encodeURIComponent(query.trim());
  const [movies, series] = await Promise.all([
    getJson<{ metas: any[] }>(`/catalog/movie/top/search=${q}.json`).catch(() => ({ metas: [] })),
    getJson<{ metas: any[] }>(`/catalog/series/top/search=${q}.json`).catch(() => ({ metas: [] })),
  ]);
  const all = [
    ...(movies.metas || []).map((m) => toItem(m, 'movie')),
    ...(series.metas || []).map((m) => toItem(m, 'series')),
  ];
  return all.filter((m) => m.name);
}

export async function fetchMeta(type: CatalogType, id: string): Promise<CatalogMeta> {
  const data = await getJson<{ meta: any }>(`/meta/${type}/${id}.json`);
  const m = data.meta || {};
  const episodes: CatalogEpisode[] = (m.videos || [])
    .map((v: any) => ({
      id: v.id,
      season: Number(v.season) || 0,
      episode: Number(v.episode ?? v.number) || 0,
      title: v.name || v.title || t('Episódio {v1}', { v1: v.episode ?? v.number }),
      overview: v.overview || v.description,
      thumbnail: v.thumbnail,
      released: v.released || v.firstAired,
    }))
    .filter((e: CatalogEpisode) => e.season > 0)
    .sort((a: CatalogEpisode, b: CatalogEpisode) => a.season - b.season || a.episode - b.episode);

  return {
    ...toItem(m, type),
    description: m.description,
    genres: m.genres || m.genre || [],
    runtime: m.runtime,
    background: m.background,
    imdbRating: m.imdbRating,
    episodes,
  };
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
