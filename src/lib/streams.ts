import { addonSupports, streamTypeFor, type VideoAddon } from './addons';
import { detectCodecs, type StreamCodecs } from './streamInfo';
import { classifyStream, type BrowserSupport, type Playability, type PlayabilityReason } from './streamPlayability';

/**
 * Pede streams aos addons e normaliza a resposta. O texto (`title`/`description`) vai como o addon mandou,
 * a lista o mostra verbatim. Nada aqui carrega a URL do addon: ela pode ter credenciais.
 */

export interface StreamOption {
  key: string;
  sourceId: string;
  sourceName: string;
  title: string;
  description: string;
  url: string;
  filename?: string;
  codecs: StreamCodecs;
  level: Playability;
  reasons: PlayabilityReason[];
}

export interface StreamTarget {
  type: 'movie' | 'series' | 'anime';
  videoId: string;
  season?: number;
  episode?: number;
  seriesId?: string;
}

export interface SourceResult {
  // Só id e nome: o VideoAddon inteiro carrega a URL (com credenciais) e este resultado vai para o estado do React
  addon: Pick<VideoAddon, 'id' | 'name'>;
  options: StreamOption[];
  dropped: number;
  failed: boolean;
}

const LEVEL_ORDER: Record<Playability, number> = { ok: 0, maybe: 1, no: 2 };

export function streamRequestUrl(addon: VideoAddon, type: string, videoId: string): string {
  return `${addon.base}/stream/${type}/${encodeURIComponent(videoId)}.json`;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const p = new URL(v).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

export function normalizeStreams(addon: VideoAddon, raw: unknown, support: BrowserSupport): { options: StreamOption[]; dropped: number } {
  const list = isObject(raw) && Array.isArray(raw.streams) ? raw.streams : [];
  const options: StreamOption[] = [];
  let dropped = 0;
  for (const item of list) {
    if (!isObject(item) || !isHttpUrl(item.url) || text(item.name).startsWith('[❌]')) {
      dropped++;
      continue;
    }
    const hints = isObject(item.behaviorHints) ? item.behaviorHints : {};
    const title = text(item.name);
    const description = text(item.description ?? item.title);
    const filename = typeof hints.filename === 'string' && hints.filename ? hints.filename : undefined;
    const proxy = isObject(hints.proxyHeaders) && isObject(hints.proxyHeaders.request) ? hints.proxyHeaders.request : {};
    const codecs = detectCodecs({ name: title, description, filename });
    const { level, reasons } = classifyStream(
      { codecs, notWebReady: hints.notWebReady === true, needsProxyHeaders: Object.keys(proxy).length > 0 },
      support,
    );
    options.push({
      key: item.url,
      sourceId: addon.id,
      sourceName: addon.name,
      title,
      description,
      url: item.url,
      ...(filename ? { filename } : {}),
      codecs,
      level,
      reasons,
    });
  }
  return { options, dropped };
}

/** Deve rodar sobre a união dos `SourceResult.options`: a mesma `url` de dois addons só é removida aqui. */
export function sortStreams(options: StreamOption[]): StreamOption[] {
  const seen = new Set<string>();
  const unique = options.filter((o) => !seen.has(o.url) && !!seen.add(o.url));
  return unique
    .map((o, i) => ({ o, i }))
    .sort((a, b) => LEVEL_ORDER[a.o.level] - LEVEL_ORDER[b.o.level] || a.i - b.i)
    .map((x) => x.o);
}

/** GET com prazo; resolve o JSON ou rejeita (também se o `fetch` ignorar o signal). */
function getJson(url: string, fetchImpl: typeof fetch, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = () => {
      stop();
      ctrl.abort();
      reject(new Error('aborted'));
    };
    const onAbort = fail;
    const timer = setTimeout(fail, timeoutMs);
    if (signal.aborted) return fail();
    signal.addEventListener('abort', onAbort);
    (async () => {
      const r = await fetchImpl(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error('http');
      return r.json();
    })().then(
      (v) => {
        stop();
        resolve(v);
      },
      () => {
        stop();
        reject(new Error('request'));
      },
    );
  });
}

/** Cada addon entrega o seu resultado; quem junta as fontes precisa passar a união por `sortStreams` para tirar `url` repetida. */
export async function fetchStreams(
  addons: VideoAddon[],
  target: StreamTarget,
  opts: {
    support: BrowserSupport;
    signal: AbortSignal;
    onSource: (r: SourceResult) => void;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<void> {
  const { support, signal, onSource } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const canRetry =
    target.type !== 'movie' && !!target.seriesId && target.season !== undefined && target.episode !== undefined;

  const attempt = async (addon: VideoAddon, type: string, id: string): Promise<SourceResult> => {
    const who = { id: addon.id, name: addon.name };
    try {
      const raw = await getJson(streamRequestUrl(addon, type, id), fetchImpl, signal, timeoutMs);
      if (!isObject(raw) || !Array.isArray(raw.streams)) throw new Error('shape');
      return { addon: who, ...normalizeStreams(addon, raw, support), failed: false };
    } catch {
      return { addon: who, options: [], dropped: 0, failed: true };
    }
  };

  // Id do episódio segundo o próprio addon, para quando ele não entende o id de origem
  const episodeId = async (addon: VideoAddon, type: string): Promise<string | null> => {
    try {
      const url = `${addon.base}/meta/${type}/${encodeURIComponent(target.seriesId!)}.json`;
      const raw = await getJson(url, fetchImpl, signal, timeoutMs);
      const videos = isObject(raw) && isObject(raw.meta) && Array.isArray(raw.meta.videos) ? raw.meta.videos : [];
      const v = videos.find((x) => isObject(x) && Number(x.season) === target.season && Number(x.episode) === target.episode);
      return isObject(v) && typeof v.id === 'string' && v.id ? v.id : null;
    } catch {
      return null;
    }
  };

  const run = async (addon: VideoAddon) => {
    const type = streamTypeFor(addon, target.type)!;
    let result = await attempt(addon, type, target.videoId);
    const empty = result.failed || (result.options.length === 0 && result.dropped > 0);
    if (empty && canRetry && !signal.aborted) {
      const id = await episodeId(addon, type);
      if (id && id !== target.videoId && !signal.aborted) {
        const second = await attempt(addon, type, id);
        if (second.options.length > 0) result = second;
      }
    }
    if (!signal.aborted) onSource(result);
  };

  await Promise.all(addons.filter((a) => addonSupports(a, target.type, target.videoId)).map(run));
}
