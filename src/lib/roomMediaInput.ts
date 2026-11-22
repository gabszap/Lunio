import { detectMimeType, getYouTubeId, shareableFingerprint, validateAndFormatUrl } from './media';
import { extractCleanTitleFromUrl } from './recent';
import { playlistUrlKey } from '../types/sync';
import { t } from './i18n';

export interface PreparedMediaLink {
  url: string;
  title: string;
  mimeType?: string;
  fingerprint?: string;
}

export type MediaLinkResult = { ok: true; item: PreparedMediaLink } | { ok: false; error: string };

/**
 * Valida, normaliza e resolve título (via oEmbed para YouTube) de um link inserido na barra da sala.
 */
export async function prepareMediaLink(
  raw: string,
  existingUrls: string[],
  maxItems: number,
  fetchFn: typeof fetch = fetch
): Promise<MediaLinkResult> {
  const url = validateAndFormatUrl(raw.trim());
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: t('Cole uma URL completa, começando com http:// ou https://') };
  }
  if (existingUrls.length >= maxItems) {
    return { ok: false, error: t('A fila está cheia.') };
  }
  const ytId = getYouTubeId(url);
  const finalUrl = ytId ? `https://www.youtube.com/watch?v=${ytId}` : url;
  if (existingUrls.some((existing) => playlistUrlKey(existing) === playlistUrlKey(finalUrl))) {
    return { ok: false, error: t('Esse vídeo já está na fila.') };
  }
  if (ytId) {
    let title = t('Vídeo do YouTube');
    try {
      const res = await fetchFn(
        `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(finalUrl)}`
      );
      if (res.ok) title = (await res.json()).title || title;
    } catch {
      // sem rede para o oEmbed: fica o título genérico
    }
    return {
      ok: true,
      item: { url: finalUrl, title, mimeType: 'video/youtube' },
    };
  }
  return {
    ok: true,
    item: {
      url,
      title: extractCleanTitleFromUrl(url) || 'Stream',
      mimeType: detectMimeType(url),
      fingerprint: shareableFingerprint(url),
    },
  };
}
