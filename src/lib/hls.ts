import { apiFetch } from './access';
import { logger } from './logger';

/**
 * Pede ao servidor o HLS compartilhado de um áudio alternativo. Devolve o caminho da playlist, ou `null` quando o HLS
 * não se aplica a este vídeo (MP4, sem Cues, codec que não é H.264, servidor ocupado…): aí o player usa o remux contínuo.
 */
export async function startHlsAudio(url: string, audio: number, fingerprint?: string): Promise<string | null> {
  try {
    const res = await apiFetch('/api/hls/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, audio, fingerprint }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      logger.info(`[Áudio] HLS indisponível para este vídeo (${body?.code || res.status}); usando o remux`);
      return null;
    }
    const body = await res.json();
    return typeof body.playlist === 'string' ? body.playlist : null;
  } catch (err) {
    logger.warn('[Áudio] Não deu pra iniciar o HLS; usando o remux:', err);
    return null;
  }
}

export const isHlsStreamUrl = (url: string) => url.startsWith('/api/hls/');
