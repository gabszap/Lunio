import crypto from 'node:crypto';
import { BoundedCache } from './cache';
import { config } from './config';
import { redisKeys, withRedis } from './media/redis';

/**
 * Catálogo de filmes e séries a partir de um addon do Stremio (AIOMetadata, Cinemeta…). O servidor é o único que fala
 * com a fonte: a URL dela (que num AIOMetadata carrega o UUID e a configuração da pessoa) nunca chega ao navegador, e as
 * respostas ficam em cache aqui, compartilhadas por todo mundo que abrir o catálogo.
 *
 * Segurança: a URL base vem do `.env` (confiável). Do navegador só entram partes validadas (tipo, id, gênero, busca),
 * montadas em caminhos fixos da API do Stremio: nenhuma URL escolhida por quem usa o site é pedida pelo servidor.
 */

export const DEFAULT_CATALOG_URL = 'https://v3-cinemeta.strem.io';

/** Aceita a URL de instalação (`stremio://…/manifest.json`, `https://…/manifest.json`) ou a base do addon. */
export function normalizeCatalogBase(raw: string | undefined | null): string {
  let url = (raw ?? '').trim();
  if (!url) return '';
  url = url.replace(/^stremio:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(url)) return '';
  url = url.split('#')[0].split('?')[0];
  url = url.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
  try {
    new URL(url);
  } catch {
    return '';
  }
  return url;
}

/** Base ativa: `CATALOG_URL` do `.env` ou, sem ela, o Cinemeta (um clone novo funciona sem configurar nada). */
export function currentCatalogBase(): string {
  return normalizeCatalogBase(config.catalogUrl) || DEFAULT_CATALOG_URL;
}

export const isDefaultCatalog = () => currentCatalogBase() === DEFAULT_CATALOG_URL;

/** Só o host, para log e rótulo: o caminho tem o UUID/configuração da pessoa. */
function hostLabel(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return 'desconhecido';
  }
}

export class CatalogUnavailableError extends Error {
  constructor(public readonly status?: number) {
    super(status ? `A fonte do catálogo respondeu ${status}.` : 'A fonte do catálogo não respondeu.');
  }
}

type Kind = 'manifest' | 'rows' | 'search' | 'meta' | 'mal';
/** Quanto uma resposta vale sem perguntar de novo à fonte. */
const FRESH_MS: Record<Kind, number> = { manifest: 60 * 60_000, rows: 15 * 60_000, search: 10 * 60_000, meta: 15 * 60_000, mal: 24 * 60 * 60_000 };
/** Depois disso, mesmo com a fonte fora do ar, a resposta guardada não é mais servida. */
const STALE_MS = 24 * 60 * 60_000;
/** Catálogos de streaming (Netflix, HBO…) numa instância fria passam de 10 s. */
const UPSTREAM_TIMEOUT_MS = 20_000;
/** Pedidos simultâneos à fonte: uma Home com muitas fileiras não deve disparar todas de uma vez numa instância fria. */
const MAX_PARALLEL_UPSTREAM = 4;
/** Resposta vazia (fonte fria ou lista que ainda não encheu) vale pouco: logo se pergunta de novo. */
const EMPTY_FRESH_MS = 30_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const store = new BoundedCache<{ value: any; at: number }>(1500, STALE_MS);
const inflight = new Map<string, Promise<any>>();
let announced = false;

let activeRequests = 0;
const waiting: Array<() => void> = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (activeRequests >= MAX_PARALLEL_UPSTREAM) await new Promise<void>((resolve) => waiting.push(resolve));
  activeRequests++;
  try {
    return await fn();
  } finally {
    activeRequests--;
    waiting.shift()?.();
  }
}

/** Algumas fontes respondem 200 com um item de erro no lugar da lista (ex.: "[❌] <nome do addon>"): isso é falha, não conteúdo. */
export function isErrorPayload(data: any): boolean {
  const names: unknown[] = Array.isArray(data?.metas) ? data.metas.map((m: any) => m?.name) : data?.meta ? [data.meta.name] : [];
  return names.length > 0 && names.every((n) => typeof n === 'string' && /^\s*\[\s*(❌|✖|✗|x)\s*\]/i.test(n));
}

// ───────────── cache que sobrevive a restart (Redis, opcional) ─────────────

const redisKeyOf = (key: string) => redisKeys.catalog(crypto.createHash('sha256').update(key).digest('hex').slice(0, 40));

async function persistedGet(key: string): Promise<{ value: any; at: number } | undefined> {
  return withRedis<{ value: any; at: number } | undefined>(undefined, async (r) => {
    const raw = await r.get(redisKeyOf(key));
    return raw ? JSON.parse(raw) : undefined;
  });
}

/** No Redis (128 MB, compartilhado com salas e envios) buscas valem 1 h, que são as que não param de aparecer; o resto, 24 h. */
const PERSIST_MS: Record<Kind, number> = { manifest: STALE_MS, rows: STALE_MS, meta: STALE_MS, mal: STALE_MS, search: 60 * 60_000 };
/** Uma resposta enorme não vai para o Redis (fica só na memória do processo). */
const PERSIST_MAX_BYTES = 512 * 1024;

function persistedSet(key: string, entry: { value: any; at: number }, kind: Kind) {
  const json = JSON.stringify(entry);
  if (json.length > PERSIST_MAX_BYTES) return;
  void withRedis<void>(undefined, (r) => r.set(redisKeyOf(key), json, 'PX', PERSIST_MS[kind]).then(() => undefined));
}

async function requestJson(url: string, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Lunio/1.0 (+catalog)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new CatalogUnavailableError();
  }
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined);
    throw new CatalogUnavailableError(res.status);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BODY_BYTES) throw new CatalogUnavailableError();
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new CatalogUnavailableError();
  }
}

/**
 * GET JSON na fonte com cache. Pedidos iguais simultâneos viram um só; se a fonte falhar, serve a última resposta
 * guardada (até 24 h) marcada como `stale`; sem nenhuma guardada, lança `CatalogUnavailableError`.
 */
export async function fetchCatalogJson(path: string, kind: Kind, opts: { base?: string; timeoutMs?: number } = {}): Promise<{ data: any; stale: boolean }> {
  const base = opts.base ?? currentCatalogBase();
  if (!announced && !opts.base) {
    announced = true;
    console.log(`[Catálogo] Fonte: ${hostLabel(base)} (${isDefaultCatalog() ? 'padrão' : 'configurada em CATALOG_URL'}).`);
  }
  const key = `${base}${path}`;
  let hit = store.get(key);
  // Depois de um restart a memória está vazia: o Redis (se houver) devolve o que já se sabia
  if (!hit) {
    hit = await persistedGet(key);
    if (hit) store.set(key, hit);
  }
  const freshFor = (e: { value: any }) =>
    (kind === 'rows' || kind === 'search') && Array.isArray(e.value?.metas) && e.value.metas.length === 0 ? EMPTY_FRESH_MS : FRESH_MS[kind];
  if (hit && Date.now() - hit.at < freshFor(hit)) return { data: hit.value, stale: false };

  let pending = inflight.get(key);
  if (!pending) {
    pending = limited(async () => {
      const data = await requestJson(key, opts.timeoutMs);
      if (isErrorPayload(data)) throw new CatalogUnavailableError();
      return data;
    }).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  try {
    const data = await pending;
    const entry = { value: data, at: Date.now() };
    store.set(key, entry);
    persistedSet(key, entry, kind);
    return { data, stale: false };
  } catch (err) {
    if (hit) {
      console.warn(`[Catálogo] ${hostLabel(base)} falhou (${(err as CatalogUnavailableError).status ?? 'sem resposta'}); servindo a resposta guardada.`);
      return { data: hit.value, stale: true };
    }
    console.warn(`[Catálogo] ${hostLabel(base)} falhou (${(err as CatalogUnavailableError).status ?? 'sem resposta'}) e não há resposta guardada.`);
    throw err;
  }
}

// ───────────── manifesto ─────────────

export interface CatalogDef {
  type: string;
  id: string;
  name: string;
  /** Gêneros aceitos como filtro (vazio = a fileira não filtra). */
  genres: string[];
  /** A fileira exige um gênero e só tem um: ele é preenchido sozinho (ex.: "MAL Melhores Séries"). */
  fixedGenre?: string;
}

export interface CatalogManifest {
  name: string;
  /** Fileiras para a Home: catálogos que não exigem nenhum parâmetro (como `search`). */
  rows: CatalogDef[];
  /** Catálogos que respondem a busca. */
  searchCatalogs: Array<{ type: string; id: string; name: string }>;
  isDefault: boolean;
  stale: boolean;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// Tipos de catálogo podem ter ponto (`anime.series`, `anime.movie`)
const TYPE_RE = /^[a-z][a-z0-9_.-]{1,29}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

/** Os formatos antigo (`extraSupported`/`extraRequired`) e novo (`extra: [{ name, isRequired, options }]`) do Stremio. */
function extraInfo(cat: any): { supported: Set<string>; required: Set<string>; genres: string[] } {
  const supported = new Set<string>();
  const required = new Set<string>();
  let genres: string[] = Array.isArray(cat?.genres) ? cat.genres.filter((g: unknown) => typeof g === 'string') : [];
  if (Array.isArray(cat?.extra)) {
    for (const e of cat.extra) {
      const name = str(e?.name, 40);
      if (!name) continue;
      supported.add(name);
      if (e?.isRequired === true) required.add(name);
      if (name === 'genre' && Array.isArray(e.options)) genres = e.options.filter((g: unknown) => typeof g === 'string');
    }
  }
  for (const n of Array.isArray(cat?.extraSupported) ? cat.extraSupported : []) if (typeof n === 'string') supported.add(n);
  for (const n of Array.isArray(cat?.extraRequired) ? cat.extraRequired : []) if (typeof n === 'string') required.add(n);
  return { supported, required, genres: genres.slice(0, 100).map((g) => g.slice(0, 60)) };
}

export function summarizeManifest(manifest: any): Omit<CatalogManifest, 'isDefault' | 'stale'> {
  const rows: CatalogDef[] = [];
  const searchCatalogs: Array<{ type: string; id: string; name: string }> = [];
  for (const cat of Array.isArray(manifest?.catalogs) ? manifest.catalogs : []) {
    const type = str(cat?.type, 30);
    const id = str(cat?.id, 100);
    if (!TYPE_RE.test(type) || !ID_RE.test(id)) continue;
    const { supported, required, genres } = extraInfo(cat);
    const name = str(cat?.name, 120) || id;
    if (supported.has('search')) searchCatalogs.push({ type, id, name });
    if (required.size === 0) rows.push({ type, id, name, genres });
    // Só o gênero é obrigatório e há uma única opção: dá para pedir a fileira com ela
    else if (required.size === 1 && required.has('genre') && genres.length === 1) rows.push({ type, id, name, genres, fixedGenre: genres[0] });
  }
  return { name: str(manifest?.name, 80) || 'Catálogo', rows, searchCatalogs };
}

export async function getManifest(): Promise<CatalogManifest> {
  const { data, stale } = await fetchCatalogJson('/manifest.json', 'manifest');
  return { ...summarizeManifest(data), isDefault: isDefaultCatalog(), stale };
}

/** Depois de uma falha, o Status não tenta de novo por este tempo (cada tentativa pode esperar até o teto). */
const STATUS_RETRY_MS = 30_000;
let statusFailedAt = 0;

/** Estado para a aba Status: nunca lança e não espera mais que `ms`. */
export async function catalogStatus(ms = 4000): Promise<{ ok: boolean; stale: boolean; name: string; isDefault: boolean }> {
  const fallback = { ok: false, stale: false, name: '', isDefault: isDefaultCatalog() };
  if (Date.now() - statusFailedAt < STATUS_RETRY_MS) return fallback;
  try {
    const m = await Promise.race([getManifest(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
    statusFailedAt = 0;
    return { ok: !m.stale, stale: m.stale, name: m.name, isDefault: m.isDefault };
  } catch {
    statusFailedAt = Date.now();
    return fallback;
  }
}

// ───────────── itens, busca e detalhes ─────────────

export interface CatalogItem {
  /** Id na fonte (`tt…`, `tmdb:…`, `mal:…`, `kitsu:…`): é o que vale para pedir o detalhe. */
  id: string;
  imdbId?: string;
  type: string;
  name: string;
  poster?: string;
  year?: string;
}

const httpUrl = (v: unknown) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v.slice(0, 600) : undefined);

export function toItem(m: any, fallbackType: string): CatalogItem | null {
  const id = str(m?.id, 100);
  const name = str(m?.name, 300);
  if (!id || !name) return null;
  const imdb = str(m?.imdb_id, 20) || (/^tt\d+$/.test(id) ? id : '');
  return {
    id,
    imdbId: /^tt\d+$/.test(imdb) ? imdb : undefined,
    type: TYPE_RE.test(str(m?.type, 20)) ? str(m?.type, 20) : fallbackType,
    name,
    poster: httpUrl(m?.poster),
    year: str(m?.releaseInfo ?? m?.year, 20) || undefined,
  };
}

export interface RowQuery {
  type: string;
  id: string;
  genre?: string;
  skip?: number;
}

export function rowPath({ type, id, genre, skip }: RowQuery): string {
  const extra = [genre ? `genre=${encodeURIComponent(genre)}` : '', skip ? `skip=${skip}` : ''].filter(Boolean).join('&');
  return `/catalog/${type}/${encodeURIComponent(id)}${extra ? `/${extra}` : ''}.json`;
}

export async function getRow(q: RowQuery): Promise<{ metas: CatalogItem[]; stale: boolean }> {
  const { data, stale } = await fetchCatalogJson(rowPath(q), 'rows');
  const metas = (Array.isArray(data?.metas) ? data.metas : []).map((m: any) => toItem(m, q.type)).filter(Boolean) as CatalogItem[];
  return { metas, stale };
}

/** No máximo isto de catálogos de busca por pesquisa (uma instância pode declarar dezenas). */
const MAX_SEARCH_CATALOGS = 8;

export interface SearchGroup {
  type: string;
  id: string;
  /** Nome do catálogo de busca, como a fonte o declara (ex.: "Anime Series Search"). */
  name: string;
  metas: CatalogItem[];
}

/**
 * Como no Stremio: cada catálogo de busca da fonte devolve o seu grupo (anime, séries, filmes, pessoas…), na ordem do
 * manifesto, sem mesclar nem esconder repetidos entre grupos (o mesmo título pode ter um id de cada fonte). Grupos vazios
 * ficam de fora; se todos os catálogos falharem, é falha.
 */
export async function search(query: string): Promise<{ groups: SearchGroup[]; stale: boolean }> {
  const manifest = await getManifest();
  const catalogs = manifest.searchCatalogs.slice(0, MAX_SEARCH_CATALOGS);
  if (catalogs.length === 0) return { groups: [], stale: manifest.stale };

  const q = encodeURIComponent(query);
  const results = await Promise.allSettled(
    catalogs.map((c) => fetchCatalogJson(`/catalog/${c.type}/${encodeURIComponent(c.id)}/search=${q}.json`, 'search').then((r) => ({ ...r, catalog: c })))
  );
  const ok = results.filter((r): r is PromiseFulfilledResult<{ data: any; stale: boolean; catalog: (typeof catalogs)[number] }> => r.status === 'fulfilled');
  if (ok.length === 0) throw new CatalogUnavailableError();

  const groups: SearchGroup[] = [];
  for (const r of ok) {
    const { catalog, data } = r.value;
    const seen = new Set<string>();
    const metas: CatalogItem[] = [];
    for (const raw of Array.isArray(data?.metas) ? data.metas : []) {
      const item = toItem(raw, catalog.type);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      metas.push(item);
    }
    if (metas.length) groups.push({ type: catalog.type, id: catalog.id, name: catalog.name, metas });
  }
  return { groups, stale: manifest.stale || ok.some((r) => r.value.stale) };
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
  /** Id do anime no MyAnimeList (da própria fonte: `_malId` ou o `mal:<id>` do item), para o link da página dele. */
  malId?: string;
  /** Nota (0–10), quantas pessoas votaram e posição no ranking do MyAnimeList, da API do MAL (ausentes se ela não respondeu). */
  malScore?: number;
  malScoredBy?: number;
  malRank?: number;
  /** Inclui a temporada 0 (especiais): quem exibe decide onde colocá-la. */
  episodes: CatalogEpisode[];
}

/** O id numérico do MyAnimeList: `_malId` do detalhe ou, num item `mal:<id>`, o próprio id. Só dígitos. */
function malIdOf(m: any, id: string): string | undefined {
  const raw = str(m?._malId ?? (id.startsWith('mal:') ? id.slice(4) : ''), 12);
  return /^\d{1,10}$/.test(raw) ? raw : undefined;
}

// ───────────── nota do MyAnimeList ─────────────

export const DEFAULT_JIKAN_URL = 'https://jikan.lucashdo.com/v1';

export interface MalStats {
  score: number;
  scoredBy?: number;
  rank?: number;
}

/** Tentativas da nota (prazo de cada uma e espera antes da seguinte). Mutável só para os testes não esperarem de verdade. */
export const malRetry = { timeouts: [7000, 10000, 12000], delays: [1000, 2000] };
/** Depois de esgotar as tentativas, não tenta de novo o mesmo anime por este tempo. */
const MAL_FAIL_WINDOW_MS = 60_000;
const malFailedAt = new BoundedCache<number>(500, MAL_FAIL_WINDOW_MS, () => Date.now());

export interface MalScoreResult {
  /** Nota 0–10, ou null: sem nota (anime ainda sem votos) ou a API não respondeu (`failed`). */
  score: number | null;
  scoredBy?: number;
  rank?: number;
  /** A API não respondeu nas tentativas: vale tentar de novo daqui a pouco. */
  failed: boolean;
}

const jikanBase = () => normalizeCatalogBase(config.jikanUrl) || DEFAULT_JIKAN_URL;

function parseMal(data: any): MalStats | undefined {
  const d = data?.data ?? data;
  const score = Number(d?.score);
  if (!Number.isFinite(score) || score <= 0 || score > 10) return undefined;
  const scoredBy = Number(d?.scoredBy ?? d?.scored_by);
  const rank = Number(d?.rank);
  return { score, scoredBy: Number.isFinite(scoredBy) && scoredBy > 0 ? scoredBy : undefined, rank: Number.isFinite(rank) && rank > 0 ? rank : undefined };
}

/** Só o que já está guardado (memória ou Redis): não vai à rede. Serve para o detalhe já vir com a nota quando ela é conhecida. */
async function cachedMalStats(malId: string): Promise<MalStats | undefined> {
  const key = `${jikanBase()}/anime/${malId}`;
  let hit = store.get(key);
  if (!hit) hit = await persistedGet(key);
  return hit && Date.now() - hit.at < FRESH_MS.mal ? parseMal(hit.value) : undefined;
}

/**
 * Nota do anime no MyAnimeList, pela API configurada em `JIKAN_URL` (instância compatível com o Jikan: `GET <base>/anime/<id>`
 * com `data.score`). Até 3 tentativas com espera entre elas (a instância pode estar fria ou limitando); guardada por 24 h.
 * É pedida à parte do detalhe: a página nunca espera por ela.
 */
export async function fetchMalScore(malId: string): Promise<MalScoreResult> {
  if (!/^\d{1,10}$/.test(malId)) return { score: null, failed: false };
  const cached = await cachedMalStats(malId);
  if (cached) return { ...cached, failed: false };
  if (malFailedAt.get(malId)) return { score: null, failed: true };

  const path = `/anime/${malId}`;
  for (let attempt = 0; attempt < malRetry.timeouts.length; attempt++) {
    try {
      const { data } = await fetchCatalogJson(path, 'mal', { base: jikanBase(), timeoutMs: malRetry.timeouts[attempt] });
      const stats = parseMal(data);
      return stats ? { ...stats, failed: false } : { score: null, failed: false };
    } catch {
      if (attempt < malRetry.timeouts.length - 1) await new Promise((r) => setTimeout(r, malRetry.delays[attempt] ?? 0));
    }
  }
  malFailedAt.set(malId, Date.now());
  console.warn(`[Catálogo] Sem a nota do MAL para ${malId} depois de ${malRetry.timeouts.length} tentativas.`);
  return { score: null, failed: true };
}

/** Anime pelo que o detalhe diz: idioma original japonês ou gênero de animação. */
function looksLikeAnime(m: any, genres: string[]): boolean {
  return str(m?._originalLanguage, 10).toLowerCase() === 'ja' || genres.some((g) => /anim/i.test(g));
}

/**
 * O IMDb não diz qual é o anime no MyAnimeList. Os itens do catálogo de busca de anime da fonte trazem os dois ids
 * (`mal:<id>` com o `imdb_id` junto): procura pelo nome e fica com o que tem o mesmo IMDb (a 1ª temporada, na ordem da fonte).
 */
async function resolveMalId(type: string, name: string, imdbId: string): Promise<string | undefined> {
  try {
    const wanted = type === 'movie' ? 'movie' : 'series';
    const manifest = await getManifest();
    const catalogs = manifest.searchCatalogs.filter((c) => c.type.startsWith('anime') && (c.type === 'anime' || c.type.includes(wanted))).slice(0, 2);
    for (const c of catalogs) {
      const { data } = await fetchCatalogJson(`/catalog/${c.type}/${encodeURIComponent(c.id)}/search=${encodeURIComponent(name.slice(0, 100))}.json`, 'search');
      for (const raw of Array.isArray(data?.metas) ? data.metas : []) {
        const item = toItem(raw, c.type);
        if (item?.imdbId === imdbId && item.id.startsWith('mal:') && /^\d{1,10}$/.test(item.id.slice(4))) return item.id.slice(4);
      }
    }
  } catch {
    // sem o id do MAL o detalhe só fica sem a nota
  }
  return undefined;
}

export async function getMeta(type: string, id: string): Promise<{ meta: CatalogMeta; stale: boolean }> {
  const { data, stale } = await fetchCatalogJson(`/meta/${type}/${encodeURIComponent(id)}.json`, 'meta');
  const m = data?.meta;
  const item = toItem({ ...m, id: m?.id ?? id }, type);
  if (!item) throw new CatalogUnavailableError();
  const episodes: CatalogEpisode[] = (Array.isArray(m?.videos) ? m.videos : [])
    .slice(0, 3000)
    .map((v: any) => ({
      id: str(v?.id, 100),
      season: v?.season === undefined || v?.season === null ? NaN : Number(v.season),
      episode: Number(v?.episode ?? v?.number) || 0,
      title: str(v?.name ?? v?.title, 300),
      overview: str(v?.overview ?? v?.description, 2000) || undefined,
      thumbnail: httpUrl(v?.thumbnail),
      released: str(v?.released ?? v?.firstAired, 40) || undefined,
    }))
    .filter((e: CatalogEpisode) => Number.isFinite(e.season) && e.season >= 0 && e.episode >= 0)
    .sort((a: CatalogEpisode, b: CatalogEpisode) => a.season - b.season || a.episode - b.episode);

  const genres = (Array.isArray(m?.genres) ? m.genres : Array.isArray(m?.genre) ? m.genre : []).filter((g: unknown) => typeof g === 'string').slice(0, 30);
  let malId = malIdOf(m, item.id);
  // Título do IMDb (tt…) que é anime e não diz o id do MAL: acha pelo catálogo de busca de anime da própria fonte
  if (!malId && item.imdbId && looksLikeAnime(m, genres)) malId = await resolveMalId(type, item.name, item.imdbId);
  // A nota não atrasa o detalhe: vem junto só se já estiver guardada; senão o cliente a pede em /api/catalog/malscore
  const stats = malId ? await cachedMalStats(malId) : undefined;
  return {
    meta: {
      ...item,
      description: str(m?.description, 4000) || undefined,
      genres,
      runtime: str(m?.runtime, 40) || undefined,
      background: httpUrl(m?.background),
      imdbRating: str(m?.imdbRating, 10) || undefined,
      malId,
      malScore: stats?.score,
      malScoredBy: stats?.scoredBy,
      malRank: stats?.rank,
      episodes,
    },
    stale,
  };
}

/** Só para testes. */
export function resetCatalogCache() {
  store.clear();
  inflight.clear();
  announced = false;
  statusFailedAt = 0;
  activeRequests = 0;
  waiting.length = 0;
}

export { TYPE_RE as CATALOG_TYPE_RE, ID_RE as CATALOG_ID_RE };
