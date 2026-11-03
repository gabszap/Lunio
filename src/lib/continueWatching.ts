/**
 * "Continuar assistindo": o que a pessoa começou a ver pelo catálogo, guardado só no navegador (`lunio_continue`). Cada entrada é um título com o
 * episódio (ou o filme) em que parou e a posição em segundos; **nunca** o link do stream (leva a chave de debrid e expira). Ao escolher um
 * stream de novo para o mesmo episódio, o vídeo abre nessa posição (`setPendingStart`).
 */

import { setPendingStart } from './startTime';

const KEY = 'lunio_continue';
export const CHANGE_EVENT = 'lunio:continue-changed';
export const MAX_CONTINUE = 20;
/** Abaixo disto o vídeo mal começou: não vira "continuar". */
export const MIN_POSITION_S = 20;
/** Passou disto, o episódio/filme conta como assistido. */
export const DONE_RATIO = 0.95;
/** Entre duas gravações do mesmo vídeo, no mínimo isto de avanço (o player avisa várias vezes por segundo). */
const WRITE_GAP_S = 4;

export interface EpisodeRef {
  videoId: string;
  season: number;
  episode: number;
}

/** O título do catálogo que toca (filme) ou de onde a série veio. */
export type CatalogRef = Pick<ContinueRef, 'type' | 'id' | 'name' | 'poster'>;

/** O que está tocando, vindo do catálogo (o App entrega ao começar). */
export interface ContinueRef {
  type: string;
  id: string;
  name: string;
  poster?: string;
  /** Série: o episódio que toca e o seguinte (se houver). Filme: nenhum dos dois. */
  episode?: EpisodeRef;
  next?: EpisodeRef | null;
}

export interface ContinueEntry {
  type: string;
  id: string;
  name: string;
  poster?: string;
  videoId?: string;
  season?: number;
  episode?: number;
  /** Segundos em que parou (0 quando a entrada aponta para o próximo episódio). */
  position: number;
  duration: number;
  /** O episódio anterior terminou: esta entrada é o próximo, ainda sem começar. */
  next?: boolean;
  updatedAt: number;
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function parseEntry(raw: unknown): ContinueEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = str(r.type, 30);
  const id = str(r.id, 100);
  const name = str(r.name, 300);
  const position = num(r.position);
  const duration = num(r.duration);
  const updatedAt = num(r.updatedAt);
  if (!type || !id || !name || position === null || duration === null || updatedAt === null) return null;
  const videoId = str(r.videoId, 200) ?? undefined;
  return {
    type,
    id,
    name,
    poster: typeof r.poster === 'string' && /^https?:\/\//i.test(r.poster) ? r.poster.slice(0, 600) : undefined,
    videoId,
    season: videoId ? num(r.season) ?? undefined : undefined,
    episode: videoId ? num(r.episode) ?? undefined : undefined,
    position,
    duration,
    next: r.next === true ? true : undefined,
    updatedAt,
  };
}

/** Do mais recente para o mais antigo; lixo no armazenamento é descartado. */
export function loadContinue(): ContinueEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .map(parseEntry)
      .filter((e): e is ContinueEntry => e !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONTINUE);
  } catch {
    return [];
  }
}

function save(list: ContinueEntry[]) {
  try {
    if (list.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_CONTINUE)));
  } catch {
    // armazenamento indisponível: só não lembra
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
}

const sameTitle = (a: { type: string; id: string }, b: { type: string; id: string }) => a.type === b.type && a.id === b.id;

export function upsertContinue(entry: ContinueEntry) {
  save([entry, ...loadContinue().filter((e) => !sameTitle(e, entry))]);
}

export function removeContinue(ref: { type: string; id: string }) {
  const list = loadContinue();
  const next = list.filter((e) => !sameTitle(e, ref));
  if (next.length !== list.length) save(next);
}

/** O episódio que vem depois de `currentId` na ordem de exibição (temporadas 1, 2… e os episódios; os especiais, temporada 0, ficam de fora). */
export function nextEpisodeOf(episodes: Array<{ id: string; season: number; episode: number }>, currentId: string): EpisodeRef | null {
  const ordered = episodes.filter((e) => e.season >= 1).sort((a, b) => a.season - b.season || a.episode - b.episode);
  const i = ordered.findIndex((e) => e.id === currentId);
  const n = i >= 0 ? ordered[i + 1] : undefined;
  return n ? { videoId: n.id, season: n.season, episode: n.episode } : null;
}

/** O que toca, a partir do contexto da série (o episódio atual e o seguinte). */
export function refFromSeriesContext(ctx: {
  seriesId: string;
  seriesTitle: string;
  seriesType: string;
  seriesPoster?: string;
  currentEpisodeId: string;
  season: number;
  episode: number;
  episodes: Array<{ id: string; season: number; episode: number }>;
}): ContinueRef {
  return {
    type: ctx.seriesType,
    id: ctx.seriesId,
    name: ctx.seriesTitle,
    poster: ctx.seriesPoster,
    episode: { videoId: ctx.currentEpisodeId, season: ctx.season, episode: ctx.episode },
    next: nextEpisodeOf(ctx.episodes, ctx.currentEpisodeId),
  };
}

/** Posição em que retomar este título/episódio, ou `null` (sem registro, já terminado, só o "próximo" ou de outro episódio). */
export function resumePositionFor(ref: Pick<ContinueRef, 'type' | 'id' | 'episode'>): number | null {
  const e = loadContinue().find((x) => sameTitle(x, ref));
  if (!e || e.next || e.position < MIN_POSITION_S) return null;
  if ((ref.episode?.videoId ?? undefined) !== e.videoId) return null;
  if (e.duration > 0 && e.position / e.duration >= DONE_RATIO) return null;
  return e.position;
}

// ───────────── o que toca agora ─────────────

let playing: ContinueRef | null = null;
let lastWritten = { key: '', position: -Infinity };

/** Chamado quando um vídeo do catálogo começa (ou, com `null`, quando o que toca não vem dele). Também deixa o vídeo abrir de onde parou. */
export function startPlayback(ref: ContinueRef | null) {
  playing = ref;
  lastWritten = { key: '', position: -Infinity };
  if (ref) {
    const at = resumePositionFor(ref);
    setPendingStart(at);
  } else {
    setPendingStart(null);
  }
}

/** O player avisa a posição enquanto o vídeo toca; só vale para o que veio do catálogo. */
export function reportProgress(position: number, duration: number, now = Date.now()) {
  const ref = playing;
  if (!ref || !Number.isFinite(position) || position < MIN_POSITION_S) return;
  const ep = ref.episode;
  const finished = duration > 0 && position / duration >= DONE_RATIO;

  if (finished) {
    // Terminou: filme (ou último episódio) sai da lista; episódio de série vira o próximo, ainda por começar
    if (ep && ref.next) {
      upsertContinue({
        type: ref.type,
        id: ref.id,
        name: ref.name,
        poster: ref.poster,
        videoId: ref.next.videoId,
        season: ref.next.season,
        episode: ref.next.episode,
        position: 0,
        duration: 0,
        next: true,
        updatedAt: now,
      });
    } else {
      removeContinue(ref);
    }
    playing = null; // já resolvido: não regrava nada depois dos créditos
    return;
  }

  const key = `${ref.type}/${ref.id}/${ep?.videoId ?? ''}`;
  if (lastWritten.key === key && Math.abs(position - lastWritten.position) < WRITE_GAP_S) return;
  lastWritten = { key, position };
  upsertContinue({
    type: ref.type,
    id: ref.id,
    name: ref.name,
    poster: ref.poster,
    videoId: ep?.videoId,
    season: ep?.season,
    episode: ep?.episode,
    position: Math.floor(position),
    duration: Math.floor(duration),
    updatedAt: now,
  });
}
