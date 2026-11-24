import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import type { Chapter, SubtitleTrack } from '../../types/media';
import { config } from '../config';
import { tryAcquireProcessSlot } from '../limits';
import { checkUrlSyntax, readText, safeRequest } from '../security';

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YTDLP_TIMEOUT_MS = 25_000;
const YTDLP_MAX_BUFFER = 20 * 1024 * 1024;
const MAX_YTDLP_CONCURRENT = 4;
const INFO_TTL_VOD_MS = 2 * 60 * 60 * 1000;
const INFO_TTL_LIVE_MS = 10 * 60 * 1000;
const MASTER_CACHE_TTL_MS = 60 * 1000;
const URL_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_INFO_ENTRIES = 1_000;
const MAX_URL_ENTRIES = 50_000;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const ALLOWED_YT_HOST_RE = /(^|\.)(googlevideo\.com|youtube\.com|ytimg\.com|ggpht\.com|googleapis\.com)$/i;

export type YouTubeProxyKind = 'hls' | 'seg' | 'sub';

export class YouTubeError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message?: string
  ) {
    super(message || code);
  }
}

export interface YouTubeResolved {
  videoId: string;
  title: string;
  duration: number;
  isLive: boolean;
  masterManifestUrl: string;
  httpHeaders: Record<string, string>;
  chapters: Chapter[];
  subtitles: SubtitleTrack[];
  expiresAt: number;
  rawMasterManifest?: string;
  rawMasterBaseUrl?: string;
  rawMasterFetchedAt?: number;
}

interface StoredTarget {
  kind: YouTubeProxyKind;
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}

const infoCache = new Map<string, YouTubeResolved>();
const inflight = new Map<string, Promise<YouTubeResolved>>();
const urlStore = new Map<string, StoredTarget>();
let activeYtDlpProcs = 0;

function ytDlpBin(): string {
  return process.env.YT_DLP_PATH?.trim() || 'yt-dlp';
}

function ytDlpCookies(): string | undefined {
  const c = process.env.YT_DLP_COOKIES?.trim();
  return c || undefined;
}

export function isAllowedYouTubeUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = checkUrlSyntax(raw);
  } catch {
    return false;
  }
  if (config.allowPrivateUrls && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    return true;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return ALLOWED_YT_HOST_RE.test(host);
}

function resolveUpstreamUrl(uri: string, baseUrl?: string): string | null {
  try {
    const resolved = baseUrl ? new URL(uri, baseUrl).href : new URL(uri).href;
    return isAllowedYouTubeUrl(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function registerTargetUrl(kind: YouTubeProxyKind, url: string, headers: Record<string, string>): string {
  const token = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${kind}\0${url}`)
    .digest('hex')
    .slice(0, 24);
  if (urlStore.size >= MAX_URL_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of urlStore) {
      if (v.expiresAt <= now) urlStore.delete(k);
    }
    while (urlStore.size >= MAX_URL_ENTRIES) {
      const oldest = urlStore.keys().next().value;
      if (!oldest) break;
      urlStore.delete(oldest);
    }
  }
  urlStore.set(token, { kind, url, headers, expiresAt: Date.now() + URL_TTL_MS });
  return token;
}

export function getYouTubeProxyTarget(
  token: string,
  expectedKind: YouTubeProxyKind
): { url: string; headers: Record<string, string> } | null {
  if (!/^[a-f0-9]{24}$/.test(token)) return null;
  const entry = urlStore.get(token);
  if (!entry || entry.kind !== expectedKind) return null;
  if (entry.expiresAt <= Date.now()) {
    urlStore.delete(token);
    return null;
  }
  return { url: entry.url, headers: entry.headers };
}

function setInfoCache(videoId: string, resolved: YouTubeResolved) {
  infoCache.delete(videoId);
  if (infoCache.size >= MAX_INFO_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of infoCache) {
      if (v.expiresAt <= now) infoCache.delete(k);
    }
    while (infoCache.size >= MAX_INFO_ENTRIES) {
      const oldest = infoCache.keys().next().value;
      if (!oldest) break;
      infoCache.delete(oldest);
    }
  }
  infoCache.set(videoId, resolved);
}

function runYtDlpJson(videoId: string): Promise<any> {
  if (activeYtDlpProcs >= MAX_YTDLP_CONCURRENT) {
    return Promise.reject(
      new YouTubeError('busy', 503, 'Servidor ocupado processando outros vídeos do YouTube. Tente novamente em instantes.')
    );
  }
  const releaseSlot = tryAcquireProcessSlot();
  if (!releaseSlot) {
    return Promise.reject(
      new YouTubeError('busy', 503, 'Servidor ocupado no momento. Tente novamente em instantes.')
    );
  }
  activeYtDlpProcs++;
  let freed = false;
  const release = () => {
    if (freed) return;
    freed = true;
    activeYtDlpProcs--;
    releaseSlot();
  };

  return new Promise((resolve, reject) => {
    const args = ['--no-playlist', '--no-warnings', '-J'];
    const cookies = ytDlpCookies();
    if (cookies) args.push('--cookies', cookies);
    args.push('--', `https://www.youtube.com/watch?v=${videoId}`);

    execFile(
      ytDlpBin(),
      args,
      { timeout: YTDLP_TIMEOUT_MS, maxBuffer: YTDLP_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        release();
        if (err) {
          const isMissing = (err as NodeJS.ErrnoException).code === 'ENOENT';
          const serverDetail = (stderr || err.message || '').trim().slice(0, 400);
          console.warn(`[YouTube] yt-dlp falhou (${videoId}): ${serverDetail}`);
          reject(
            new YouTubeError(
              isMissing ? 'yt_dlp_missing' : 'yt_dlp_failed',
              503,
              isMissing
                ? 'yt-dlp não está disponível no servidor.'
                : 'Não foi possível obter o stream deste vídeo do YouTube.'
            )
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new YouTubeError('yt_dlp_parse_failed', 502, 'Resposta inválida do yt-dlp.'));
        }
      }
    );
  });
}

function sanitizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    const lower = k.toLowerCase();
    if (lower === 'user-agent' || lower === 'accept' || lower === 'accept-language') {
      out[k] = v;
    }
  }
  if (!Object.keys(out).some((k) => k.toLowerCase() === 'user-agent')) {
    out['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }
  return out;
}

const SUB_LANG_PRIORITY = ['pt-BR', 'pt', 'en', 'en-US', 'es', 'ja'];

function extractSubtitles(rawSubs: any, headers: Record<string, string>): SubtitleTrack[] {
  if (!rawSubs || typeof rawSubs !== 'object') return [];
  const tracks: Array<SubtitleTrack & { priority: number }> = [];
  for (const [lang, list] of Object.entries(rawSubs as Record<string, any>)) {
    if (!Array.isArray(list)) continue;
    const vtt = list.find(
      (item) => item && item.ext === 'vtt' && typeof item.url === 'string' && isAllowedYouTubeUrl(item.url)
    );
    if (!vtt) continue;
    const tok = registerTargetUrl('sub', vtt.url, headers);
    const idx = SUB_LANG_PRIORITY.findIndex(
      (p) => p.toLowerCase() === lang.toLowerCase() || lang.toLowerCase().startsWith(`${p.toLowerCase()}-`)
    );
    tracks.push({
      id: `yt_sub_${lang}`,
      src: `/api/youtube/sub/${tok}`,
      label: typeof vtt.name === 'string' && vtt.name.trim() ? vtt.name.trim() : lang,
      language: lang,
      type: 'vtt',
      priority: idx >= 0 ? idx : 100,
    });
  }
  tracks.sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label));
  return tracks.slice(0, 20).map(({ priority: _p, ...rest }) => rest);
}

function extractChapters(rawChapters: any): Chapter[] {
  if (!Array.isArray(rawChapters)) return [];
  return rawChapters
    .filter((c) => c && typeof c.start_time === 'number' && typeof c.title === 'string' && c.title.trim())
    .map((c) => ({
      startTime: Math.max(0, Number(c.start_time)),
      endTime: typeof c.end_time === 'number' ? Math.max(0, Number(c.end_time)) : undefined,
      title: String(c.title).trim(),
    }));
}

export async function resolveYouTube(videoId: string): Promise<YouTubeResolved> {
  if (!YT_ID_RE.test(videoId)) {
    throw new YouTubeError('invalid_video_id', 400, 'ID de vídeo do YouTube inválido.');
  }
  const cached = infoCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }
  if (cached) infoCache.delete(videoId);

  const running = inflight.get(videoId);
  if (running) return running;

  const task = (async () => {
    const data = await runYtDlpJson(videoId);
    const formats: any[] = Array.isArray(data?.formats) ? data.formats : [];
    const hlsFormat = formats.find(
      (f) =>
        typeof f?.manifest_url === 'string' &&
        isAllowedYouTubeUrl(f.manifest_url) &&
        String(f.protocol || '').includes('m3u8')
    );
    const fallbackManifest =
      typeof data?.manifest_url === 'string' && isAllowedYouTubeUrl(data.manifest_url) ? data.manifest_url : null;
    const masterManifestUrl: string | null = hlsFormat?.manifest_url || fallbackManifest;

    if (!masterManifestUrl) {
      throw new YouTubeError('no_hls_manifest', 503, 'Stream HLS não disponível para este vídeo.');
    }

    const httpHeaders = sanitizeHeaders(hlsFormat?.http_headers || data?.http_headers);
    const isLive = Boolean(data?.is_live);
    const resolved: YouTubeResolved = {
      videoId,
      title: typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : 'Vídeo do YouTube',
      duration: typeof data?.duration === 'number' && Number.isFinite(data.duration) ? data.duration : 0,
      isLive,
      masterManifestUrl,
      httpHeaders,
      chapters: extractChapters(data?.chapters),
      subtitles: extractSubtitles(data?.subtitles, httpHeaders),
      expiresAt: Date.now() + (isLive ? INFO_TTL_LIVE_MS : INFO_TTL_VOD_MS),
    };
    setInfoCache(videoId, resolved);
    return resolved;
  })();

  inflight.set(videoId, task);
  try {
    return await task;
  } finally {
    if (inflight.get(videoId) === task) inflight.delete(videoId);
  }
}

function readAttr(line: string, name: string): string | null {
  const re = new RegExp(`${name}=(?:"([^"]*)"|([^,\\s]*))`);
  const m = re.exec(line);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * Filtra o manifesto HLS master do YouTube para manter apenas faixas H.264 (`avc1`, ou sem codec
 * explícito em lives) compatíveis com hls.js, deduplica por resolução/FPS preferindo o maior bitrate
 * (áudio AAC 128k grupo 234 em vez de 233) e reescreve todas as URLs para o proxy opaco do servidor.
 */
export function filterAndRewriteMasterManifest(
  raw: string,
  registerUrl: (upstreamUrl: string) => string,
  tokenQuery: string,
  baseUrl?: string
): { playlist: string; streamCount: number } {
  const lines = raw.split(/\r?\n/);
  const mediaLines: Array<{ line: string; groupId: string | null }> = [];
  const headerLines: string[] = [];
  const variants: Array<{ inf: string; url: string; key: string; bandwidth: number; audioGroup: string | null }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA:')) {
      mediaLines.push({ line, groupId: readAttr(line, 'GROUP-ID') });
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const nextUrl = (lines[i + 1] || '').trim();
      i++;
      if (!nextUrl || nextUrl.startsWith('#')) continue;
      const resolvedUrl = resolveUpstreamUrl(nextUrl, baseUrl);
      if (!resolvedUrl) continue;

      const codecs = (readAttr(line, 'CODECS') || '').toLowerCase();
      // O YouTube inclui segmentos VP9/AV1 em WebM/fMP4 não-padrão dentro do HLS (.ts com wft/1) que o hls.js rejeita.
      if (codecs && !codecs.includes('avc1')) continue;

      const res = readAttr(line, 'RESOLUTION') || '';
      const fps = readAttr(line, 'FRAME-RATE') || '';
      const bw = parseInt(readAttr(line, 'BANDWIDTH') || '0', 10) || 0;
      const audioGroup = readAttr(line, 'AUDIO');
      const key = res ? `${res}@${fps}` : `bw_${bw}_${variants.length}`;
      variants.push({ inf: line, url: resolvedUrl, key, bandwidth: bw, audioGroup });
      continue;
    }

    if (line.startsWith('#')) {
      headerLines.push(line);
    }
  }

  // Deduplica por (RESOLUTION, FRAME-RATE) mantendo a variante de maior bitrate (ex.: áudio 234 em vez de 233)
  const bestByKey = new Map<string, (typeof variants)[number]>();
  for (const v of variants) {
    const prev = bestByKey.get(v.key);
    if (!prev || v.bandwidth > prev.bandwidth) {
      bestByKey.set(v.key, v);
    }
  }
  const kept = Array.from(bestByKey.values()).sort((a, b) => a.bandwidth - b.bandwidth);
  const usedAudioGroups = new Set(kept.map((v) => v.audioGroup).filter((g): g is string => Boolean(g)));

  const out: string[] = [];
  if (!headerLines.some((l) => l.startsWith('#EXTM3U'))) out.push('#EXTM3U');
  out.push(...headerLines);

  for (const m of mediaLines) {
    if (m.groupId && usedAudioGroups.size > 0 && !usedAudioGroups.has(m.groupId)) continue;
    let validUri = true;
    const rewritten = m.line.replace(/URI="([^"]+)"/, (_all, uri: string) => {
      const resolvedUri = resolveUpstreamUrl(uri, baseUrl);
      if (!resolvedUri) {
        validUri = false;
        return '';
      }
      const tok = registerUrl(resolvedUri);
      return `URI="/api/youtube/hls/${tok}.m3u8${tokenQuery}"`;
    });
    if (validUri) out.push(rewritten);
  }

  for (const v of kept) {
    const tok = registerUrl(v.url);
    out.push(v.inf);
    out.push(`/api/youtube/hls/${tok}.m3u8${tokenQuery}`);
  }

  return { playlist: `${out.join('\n')}\n`, streamCount: kept.length };
}

export function rewriteVariantPlaylist(
  raw: string,
  registerUrl: (upstreamUrl: string) => string,
  tokenQuery: string,
  baseUrl?: string
): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      let validUri = true;
      const rewritten = line.replace(/URI="([^"]+)"/, (_all, uri: string) => {
        const resolvedUri = resolveUpstreamUrl(uri, baseUrl);
        if (!resolvedUri) {
          validUri = false;
          return '';
        }
        const tok = registerUrl(resolvedUri);
        return `URI="/api/youtube/seg/${tok}.ts${tokenQuery}"`;
      });
      if (validUri) out.push(rewritten);
      continue;
    }
    if (line.startsWith('#')) {
      out.push(line);
      continue;
    }
    const resolvedUri = resolveUpstreamUrl(line, baseUrl);
    if (resolvedUri) {
      const tok = registerUrl(resolvedUri);
      out.push(`/api/youtube/seg/${tok}.ts${tokenQuery}`);
    }
  }
  return `${out.join('\n')}\n`;
}

export async function getYouTubeMasterPlaylist(videoId: string, tokenQuery: string): Promise<string> {
  const resolved = await resolveYouTube(videoId);
  let raw = resolved.rawMasterManifest;
  let baseUrl = resolved.rawMasterBaseUrl || resolved.masterManifestUrl;

  if (!raw || !resolved.rawMasterFetchedAt || Date.now() - resolved.rawMasterFetchedAt > MASTER_CACHE_TTL_MS) {
    if (!isAllowedYouTubeUrl(resolved.masterManifestUrl)) {
      infoCache.delete(videoId);
      throw new YouTubeError('upstream_blocked', 403, 'URL de manifesto não permitida.');
    }
    const res = await safeRequest(resolved.masterManifestUrl, {
      headers: resolved.httpHeaders,
      timeoutMs: 15_000,
    });
    if (res.status < 200 || res.status >= 300) {
      res.body.resume();
      infoCache.delete(videoId);
      throw new YouTubeError('upstream_failed', 502, 'Falha ao carregar o manifesto do YouTube.');
    }
    if (!isAllowedYouTubeUrl(res.url)) {
      res.body.resume();
      infoCache.delete(videoId);
      throw new YouTubeError('upstream_blocked', 403, 'Redirecionamento não permitido.');
    }
    raw = await readText(res.body, MAX_PLAYLIST_BYTES);
    baseUrl = res.url;
    resolved.rawMasterManifest = raw;
    resolved.rawMasterBaseUrl = baseUrl;
    resolved.rawMasterFetchedAt = Date.now();
  }

  const { playlist, streamCount } = filterAndRewriteMasterManifest(
    raw,
    (u) => registerTargetUrl('hls', u, resolved.httpHeaders),
    tokenQuery,
    baseUrl
  );
  if (streamCount === 0) {
    throw new YouTubeError('no_compatible_streams', 503, 'Nenhuma qualidade H.264 compatível encontrada.');
  }
  return playlist;
}

export async function getYouTubeVariantPlaylist(token: string, tokenQuery: string): Promise<string> {
  const target = getYouTubeProxyTarget(token, 'hls');
  if (!target) throw new YouTubeError('not_found', 404, 'Playlist expirada ou desconhecida.');
  if (!isAllowedYouTubeUrl(target.url)) {
    throw new YouTubeError('upstream_blocked', 403, 'URL de playlist não permitida.');
  }
  const res = await safeRequest(target.url, { headers: target.headers, timeoutMs: 15_000 });
  if (res.status < 200 || res.status >= 300) {
    res.body.resume();
    throw new YouTubeError('upstream_failed', 502, 'Falha ao carregar a variante HLS do YouTube.');
  }
  if (!isAllowedYouTubeUrl(res.url)) {
    res.body.resume();
    throw new YouTubeError('upstream_blocked', 403, 'Redirecionamento não permitido.');
  }
  const raw = await readText(res.body, MAX_PLAYLIST_BYTES);
  return rewriteVariantPlaylist(raw, (u) => registerTargetUrl('seg', u, target.headers), tokenQuery, res.url);
}
