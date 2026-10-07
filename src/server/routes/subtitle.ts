import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendApiError } from '../http';
import { isBlockedError } from '../security';
import { getOrExtractSubtitle } from '../media/subtitles';

/** GET /api/subtitle?url=…&track=… — extrai uma legenda embutida (mkv_extractor → FFmpeg), com cache em disco. */
export async function handleSubtitle(req: IncomingMessage, res: ServerResponse) {
  let track: string | null = null;
  try {
    const reqUrl = new URL(req.url || '', 'http://localhost');
    const targetUrl = reqUrl.searchParams.get('url');
    track = reqUrl.searchParams.get('track');
    const customFingerprint = (reqUrl.searchParams.get('fingerprint') || '').slice(0, 200) || undefined;

    if (!targetUrl || !track || !/^\d{1,4}$/.test(track)) {
      sendApiError(res, 400, 'bad_request', 'Parâmetros url e track são obrigatórios.');
      return;
    }

    // A extração continua em background mesmo se o cliente desconectar momentaneamente, garantindo que o arquivo fique no cache
    const content = await getOrExtractSubtitle(targetUrl, track, customFingerprint);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(content);
  } catch (e: any) {
    // O detalhe (stderr do FFmpeg, caminhos) fica só no log; o cliente recebe código + frase genérica
    console.warn(`[Subtitle] Falha na extração da faixa #${track || 'unknown'}:`, e?.message);
    if (isBlockedError(e)) {
      sendApiError(res, 403, 'url_blocked');
    } else if (e?.code === 'busy') {
      res.setHeader('Retry-After', '5');
      sendApiError(res, 503, 'busy');
    } else if (e?.code === 'BITMAP_NOT_SUPPORTED') {
      sendApiError(res, 415, 'BITMAP_NOT_SUPPORTED');
    } else {
      sendApiError(res, 422, 'EXTRACTION_FAILED');
    }
  }
}
