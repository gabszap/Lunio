import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendApiError, sendJson } from '../http';
import {
  YouTubeError,
  getYouTubeMasterPlaylist,
  getYouTubeProxyTarget,
  getYouTubeVariantPlaylist,
  isAllowedYouTubeUrl,
  resolveYouTube,
} from '../media/youtube';
import { isBlockedError, readText, safeRequest } from '../security';

const ALLOWED_SEGMENT_MIME = new Set([
  'video/mp2t',
  'video/mp4',
  'audio/mp4',
  'video/webm',
  'audio/webm',
  'application/octet-stream',
]);
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

function safeSegmentMime(raw: string | string[] | undefined): string {
  const first = (Array.isArray(raw) ? raw[0] : raw || '').split(';')[0].trim().toLowerCase();
  return ALLOWED_SEGMENT_MIME.has(first) ? first : 'video/mp2t';
}

/**
 * YouTube estilo mpv (yt-dlp → HLS H.264/AAC nativo proxied pelo servidor):
 *  - GET /api/youtube/info?id=<videoId>           → { mode: 'hls', masterUrl, title, duration, isLive, chapters, subtitles }
 *  - GET /api/youtube/master/<videoId>.m3u8       → manifesto master filtrado/reescrito
 *  - GET /api/youtube/hls/<token>.m3u8            → playlist da qualidade/áudio com segmentos opacos
 *  - GET /api/youtube/seg/<token>.ts              → proxy direto do segmento GoogleVideo
 *  - GET /api/youtube/sub/<token>                 → proxy da legenda VTT do YouTube
 */
export async function handleYouTube(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendApiError(res, 405, 'method_not_allowed');
  }

  const url = new URL(req.url || '', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // montado em /api/youtube
  const token = url.searchParams.get('t');
  const tokenQuery = token ? `?t=${encodeURIComponent(token)}` : '';

  try {
    if (parts[0] === 'info') {
      const id = (url.searchParams.get('id') || '').trim();
      const resolved = await resolveYouTube(id);
      // Valida já aqui se há manifesto compatível (e deixa o manifesto em cache curto para `/master`)
      await getYouTubeMasterPlaylist(id, tokenQuery);
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, 200, {
        mode: 'hls',
        masterUrl: `/api/youtube/master/${resolved.videoId}.m3u8`,
        title: resolved.title,
        duration: resolved.duration,
        isLive: resolved.isLive,
        chapters: resolved.chapters,
        subtitles: resolved.subtitles,
      });
    }

    if (parts[0] === 'master' && parts[1]) {
      const m = /^([A-Za-z0-9_-]{11})\.m3u8$/.exec(parts[1]);
      if (!m) return sendApiError(res, 404, 'not_found');
      const playlist = await getYouTubeMasterPlaylist(m[1], tokenQuery);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(req.method === 'HEAD' ? undefined : playlist);
      return;
    }

    if (parts[0] === 'hls' && parts[1]) {
      const m = /^([a-f0-9]{24})\.m3u8$/.exec(parts[1]);
      if (!m) return sendApiError(res, 404, 'not_found');
      const playlist = await getYouTubeVariantPlaylist(m[1], tokenQuery);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(req.method === 'HEAD' ? undefined : playlist);
      return;
    }

    if (parts[0] === 'seg' && parts[1]) {
      const m = /^([a-f0-9]{24})\.ts$/.exec(parts[1]);
      if (!m) return sendApiError(res, 404, 'not_found');
      const target = getYouTubeProxyTarget(m[1], 'seg');
      if (!target || !isAllowedYouTubeUrl(target.url)) return sendApiError(res, 404, 'not_found');

      const headers: Record<string, string> = { ...target.headers };
      if (typeof req.headers.range === 'string') headers.Range = req.headers.range;

      const upstream = await safeRequest(target.url, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        timeoutMs: 20_000,
      });
      if (!isAllowedYouTubeUrl(upstream.url)) {
        upstream.body.resume();
        return sendApiError(res, 403, 'url_blocked');
      }
      if ((upstream.status < 200 || upstream.status >= 300) && upstream.status !== 206) {
        upstream.body.resume();
        return sendApiError(res, upstream.status === 403 ? 410 : 502, 'upstream_failed');
      }

      res.statusCode = upstream.status;
      res.setHeader('Content-Type', safeSegmentMime(upstream.headers['content-type']));
      const len = upstream.headers['content-length'];
      if (len) res.setHeader('Content-Length', len);
      const range = upstream.headers['content-range'];
      if (range) res.setHeader('Content-Range', range);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', 'sandbox');

      if (req.method === 'HEAD') {
        upstream.body.resume();
        res.end();
        return;
      }

      const abortUpstream = () => {
        if (!upstream.body.destroyed) upstream.body.destroy();
      };
      req.once('close', abortUpstream);
      upstream.body.on('error', () => {
        if (!res.writableEnded) res.destroy();
      });
      upstream.body.pipe(res);
      return;
    }

    if (parts[0] === 'sub' && parts[1]) {
      if (!/^[a-f0-9]{24}$/.test(parts[1])) return sendApiError(res, 404, 'not_found');
      const target = getYouTubeProxyTarget(parts[1], 'sub');
      if (!target || !isAllowedYouTubeUrl(target.url)) return sendApiError(res, 404, 'not_found');

      const upstream = await safeRequest(target.url, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: target.headers,
        timeoutMs: 15_000,
      });
      if (!isAllowedYouTubeUrl(upstream.url)) {
        upstream.body.resume();
        return sendApiError(res, 403, 'url_blocked');
      }
      if (upstream.status < 200 || upstream.status >= 300) {
        upstream.body.resume();
        return sendApiError(res, 502, 'upstream_failed');
      }

      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', 'sandbox');

      if (req.method === 'HEAD') {
        upstream.body.resume();
        res.end();
        return;
      }

      req.once('close', () => {
        if (!upstream.body.destroyed) upstream.body.destroy();
      });
      const text = await readText(upstream.body, MAX_SUBTITLE_BYTES);
      res.end(text);
      return;
    }

    return sendApiError(res, 404, 'not_found');
  } catch (err: any) {
    if (err?.name === 'AbortError' || res.destroyed) return;
    if (isBlockedError(err)) {
      if (!res.headersSent) return sendApiError(res, 403, 'url_blocked');
      return;
    }
    if (err instanceof YouTubeError) {
      if (!res.headersSent) return sendApiError(res, err.status, err.code, err.message);
      return;
    }
    console.error('[YouTube] Erro:', err?.message || err);
    if (!res.headersSent) sendApiError(res, 502, 'upstream_failed');
  }
}
