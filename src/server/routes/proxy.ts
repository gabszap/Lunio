import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendApiError } from '../http';
import { isBlockedError } from '../security';
import { pipeMediaStreamDirect } from '../media/stream';
import { handleRemux } from '../media/remux';
import { resolveFinalCdnUrl } from '../media/resolver';

/** GET /api/proxy?url=… — stream com HTTP Range; com `audio=` faz remux fMP4 via FFmpeg. */
export async function handleProxy(req: IncomingMessage, res: ServerResponse) {
  try {
    const reqUrl = new URL(req.url || '', 'http://localhost');
    const targetUrl = reqUrl.searchParams.get('url');
    const audioTrack = reqUrl.searchParams.get('audio');
    const seekSeconds = Math.min(86400, Math.max(0, parseFloat(reqUrl.searchParams.get('ss') || '0') || 0));
    const rawSession = reqUrl.searchParams.get('session') || '';
    const sessionId = /^[\w-]{1,64}$/.test(rawSession) ? rawSession : '';
    const generation = parseInt(reqUrl.searchParams.get('gen') || '0', 10) || 0;
    const explicitRemux = reqUrl.searchParams.get('remux') === 'true';

    if (!targetUrl) {
      sendApiError(res, 400, 'bad_request', 'Parâmetro url ausente.');
      return;
    }
    // O índice de áudio vai direto para um argumento do FFmpeg: só número
    if (audioTrack !== null && !/^\d{0,3}$/.test(audioTrack)) {
      sendApiError(res, 400, 'bad_request', 'Faixa de áudio inválida.');
      return;
    }

    // Remux via FFmpeg ativado APENAS quando o usuário selecionar dublagem alternativa específica ou explicitamente solicitado
    const hasCustomAudio =
      audioTrack !== null &&
      audioTrack !== undefined &&
      audioTrack !== '' &&
      audioTrack !== '0';
    const shouldRemux = hasCustomAudio || explicitRemux;

    if (shouldRemux) {
      await handleRemux(req, res, { targetUrl, audioTrack, seekSeconds, sessionId, generation });
      return;
    }

    // Streaming direto via Range 206 com CDN pré-resolvida
    const actualFetchUrl = await resolveFinalCdnUrl(targetUrl);
    pipeMediaStreamDirect(actualFetchUrl, targetUrl, req, res);
  } catch (err: any) {
    if (isBlockedError(err)) {
      sendApiError(res, 403, 'url_blocked');
      return;
    }
    console.error('[MediaProxy] Erro geral:', err);
    if (!res.headersSent) sendApiError(res, 502, 'upstream_failed');
  }
}
