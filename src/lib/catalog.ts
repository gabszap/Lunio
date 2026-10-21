import { t, msg } from './/i18n';
import { apiFetch } from './access';
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

export interface CatalogManifest {
  name: string;
  rows: CatalogRow[];
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

export async function fetchRow(row: Pick<CatalogRow, 'type' | 'id'> & { fixedGenre?: string }, genre?: string): Promise<CatalogItem[]> {
  const q = new URLSearchParams({ type: row.type, id: row.id });
  const g = genre ?? (row as CatalogRow).fixedGenre;
  if (g) q.set('genre', g);
  const data = await getJson<{ metas: CatalogItem[] }>(`row?${q}`);
  return data.metas || [];
}

/** Um grupo por catálogo de busca da fonte, como no Stremio (grupos sem resultado nem chegam). */
export async function searchCatalog(query: string): Promise<SearchGroup[]> {
  const data = await getJson<{ groups: SearchGroup[] }>(`search?${new URLSearchParams({ q: query.trim() })}`);
  return data.groups || [];
}

export async function fetchMeta(type: CatalogType, id: string): Promise<CatalogMeta> {
  const data = await getJson<{ meta: CatalogMeta }>(`meta?${new URLSearchParams({ type, id })}`);
  return data.meta;
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
