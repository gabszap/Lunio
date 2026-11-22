import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { sendApiError, sendJson } from '../http';
import {
  YouTubeError,
  getYouTubeMasterPlaylist,
  getYouTubeProxyTarget,
  getYouTubeVariantPlaylist,
  resolveYouTube,
} from '../media/youtube';

/**
 * YouTube estilo mpv (yt-dlp → HLS H.264/AAC nativo proxied pelo servidor):
 *  - GET /api/youtube/info?id=<videoId>           → { mode: 'hls', masterUrl, title, duration, isLive, chapters, subtitles }
 *  - GET /api/youtube/master/<videoId>.m3u8       → manifesto master filtrado/reescrito
 *  - GET /api/youtube/hls/<token>.m3u8            → playlist da qualidade/áudio com segmentos opacos
 *  - GET /api/youtube/seg/<token>.ts              → proxy direto do segmento GoogleVideo
 *  - GET /api/youtube/sub/<token>                 → proxy da legenda VTT do YouTube
 */
export async function handleYouTube(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // montado em /api/youtube
  const token = url.searchParams.get('t');
  const tokenQuery = token ? `?t=${encodeURIComponent(token)}` : '';

  try {
    if (parts[0] === 'info') {
      const id = (url.searchParams.get('id') || '').trim();
      const resolved = await resolveYouTube(id);
      // Valida já aqui se há manifesto compatível para que o cliente só entre em modo HLS quando garantido
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
      res.end(playlist);
      return;
    }

    if (parts[0] === 'hls' && parts[1]) {
      const m = /^([a-f0-9]{24})\.m3u8$/.exec(parts[1]);
      if (!m) return sendApiError(res, 404, 'not_found');
      const playlist = await getYouTubeVariantPlaylist(m[1], tokenQuery);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(playlist);
      return;
    }

    if (parts[0] === 'seg' && parts[1]) {
      const m = /^([a-f0-9]{24})\.ts$/.exec(parts[1]);
      if (!m) return sendApiError(res, 404, 'not_found');
      const target = getYouTubeProxyTarget(m[1]);
      if (!target) return sendApiError(res, 404, 'not_found');

      const ac = new AbortController();
      req.on('close', () => ac.abort());

      const headers: Record<string, string> = { ...target.headers };
      if (typeof req.headers.range === 'string') headers.Range = req.headers.range;

      const upstream = await fetch(target.url, { headers, signal: ac.signal });
      if (!upstream.ok && upstream.status !== 206) {
        return sendApiError(res, upstream.status === 403 ? 410 : 502, 'upstream_failed');
      }
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp2t');
      const len = upstream.headers.get('content-length');
      if (len) res.setHeader('Content-Length', len);
      const range = upstream.headers.get('content-range');
      if (range) res.setHeader('Content-Range', range);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (req.method === 'HEAD' || !upstream.body) {
        res.end();
        return;
      }
      const stream = Readable.fromWeb(upstream.body as any);
      stream.on('error', () => {
        if (!res.writableEnded) res.destroy();
      });
      stream.pipe(res);
      return;
    }

    if (parts[0] === 'sub' && parts[1]) {
      if (!/^[a-f0-9]{24}$/.test(parts[1])) return sendApiError(res, 404, 'not_found');
      const target = getYouTubeProxyTarget(parts[1]);
      if (!target) return sendApiError(res, 404, 'not_found');
      const upstream = await fetch(target.url, { headers: target.headers });
      if (!upstream.ok) return sendApiError(res, 502, 'upstream_failed');
      const text = await upstream.text();
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.end(text);
      return;
    }

    return sendApiError(res, 404, 'not_found');
  } catch (err: any) {
    if (err?.name === 'AbortError') return;
    if (err instanceof YouTubeError) {
      return sendApiError(res, err.status, err.code, err.message);
    }
    console.error('[YouTube] Erro:', err?.message || err);
    if (!res.headersSent) sendApiError(res, 502, 'upstream_failed');
  }
}
