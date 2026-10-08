import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { sendApiError } from '../http';
import { spawnLimited } from '../limits';
import { isBlockedError } from '../security';
import { ffmpegBin } from '../tools';
import { FFMPEG_NET_ONLY } from '../media/ffmpeg';
import { getMediaFingerprint } from '../media/fingerprint';
import { SUB_CACHE_DIR } from '../media/paths';
import { resolveFinalCdnUrl } from '../media/resolver';
import { getOrExtractSubtitle } from '../media/subtitles';
import { parseTracks, tracksCache } from '../media/tracks';

/** GET /api/tracks?url=… — faixas de áudio/legenda, capítulos, fontes e duração via FFmpeg. */
export async function handleTracks(req: IncomingMessage, res: ServerResponse) {
  try {
    const reqUrl = new URL(req.url || '', 'http://localhost');
    const targetUrl = reqUrl.searchParams.get('url');
    const trackFingerprint = (reqUrl.searchParams.get('fingerprint') || '').slice(0, 200) || undefined;
    if (!targetUrl) {
      sendApiError(res, 400, 'bad_request', 'Parâmetro url ausente.');
      return;
    }

    if (tracksCache.has(targetUrl)) {
      const cached = tracksCache.get(targetUrl)!;
      const hasGenericChapters =
        cached.chapters &&
        cached.chapters.length > 0 &&
        cached.chapters.some((c: any) => /^Capítulo \d+$/i.test(c.title));

      const hasNoneSubtitles =
        cached.subtitles &&
        cached.subtitles.some((s: any) => s.codec === 'none');

      const hasDuration = typeof cached.duration === 'number' && cached.duration > 0;

      if (!hasGenericChapters && !hasNoneSubtitles && hasDuration) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(cached));
        return;
      }
      tracksCache.delete(targetUrl);
    }

    let streamUrl = await resolveFinalCdnUrl(targetUrl);

    const args = [
      '-hide_banner',
      ...FFMPEG_NET_ONLY,
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
      '-probesize', '10M',
      '-analyzeduration', '10M',
      '-i', streamUrl,
    ];

    const proc = spawnLimited(ffmpegBin(), args);
    if (!proc) {
      res.setHeader('Retry-After', '5');
      sendApiError(res, 503, 'busy');
      return;
    }
    proc.on('error', (err) => {
      console.error('[Tracks] Não foi possível iniciar o FFmpeg:', err.message);
      if (!res.headersSent) sendApiError(res, 500, 'internal');
    });
    let stderr = '';

    proc.stderr.on('data', (d) => stderr += d.toString());

    proc.on('close', () => {
      try {
        const result = parseTracks(stderr, targetUrl, streamUrl);
        tracksCache.set(targetUrl, result);
        const { title: cleanTitle, rawTitle: rawFileTitle, duration: mediaDuration, audios, subtitles, chapters, fonts } = result;

        // Pré-extração não-bloqueante em background das faixas em português (tanto Forced quanto Completo) e forçadas (und)
        const ptSubs = subtitles.filter(
          (s: any) =>
            s.language?.toLowerCase().includes('por') ||
            s.language?.toLowerCase().includes('pt') ||
            s.title?.toLowerCase().includes('portugu') ||
            s.title?.toLowerCase().includes('brasil') ||
            s.title?.toLowerCase().includes('brazil') ||
            (s.isForced && (s.language === 'und' || !s.language))
        );

        const subsToPreExtract = ptSubs.length > 0 ? ptSubs : (subtitles[0] ? [subtitles[0]] : []);

        for (const pSub of subsToPreExtract) {
          if (pSub && pSub.index !== undefined) {
            const subTrackIdx = String(pSub.index);
            const subHash = getMediaFingerprint(targetUrl, trackFingerprint);
            const subCacheFile = path.join(SUB_CACHE_DIR, `${subHash}_s${subTrackIdx}.ass`);
            if (!fs.existsSync(subCacheFile)) {
              console.log(`[Tracks] 🚀 Pré-extraindo legenda prioritária #${subTrackIdx} (${pSub.title}) em background para o cache...`);
              getOrExtractSubtitle(targetUrl, subTrackIdx, trackFingerprint).catch((e) => {
                console.warn(`[Tracks] Pré-extração de legenda deferida:`, e.message);
              });
            }
          }
        }

        console.log(`[Tracks] 🎬 Título: "${cleanTitle}" | Duração: ${mediaDuration.toFixed(1)}s | Original: "${rawFileTitle}"`);
        console.log(`[Tracks] Detectados ${audios.length} áudios, ${subtitles.length} legendas, ${chapters.length} capítulos e ${fonts.length} fontes embutidas via FFmpeg.`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (err: any) {
        console.error('[Tracks] Falha ao interpretar a saída do FFmpeg:', err?.message, stderr.slice(-300));
        if (!res.headersSent) sendApiError(res, 500, 'internal');
      }
    });
  } catch (e: any) {
    if (isBlockedError(e)) {
      sendApiError(res, 403, 'url_blocked');
      return;
    }
    console.error('[Tracks] Erro:', e?.message);
    sendApiError(res, 500, 'internal');
  }
}
