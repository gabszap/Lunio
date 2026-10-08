import { redactUrl } from '../http';
import { assertPublicUrl, isBlockedError, safeRequest } from '../security';

/** URL original (Torrentio/debrid) → URL final da CDN, já validada contra SSRF. */
export const resolvedUrlCache = new Map<string, string>();

export async function resolveFinalCdnUrl(url: string): Promise<string> {
  // Lança UrlBlockedError se a URL (ou algum redirecionamento) apontar para rede interna
  await assertPublicUrl(url);
  if (resolvedUrlCache.has(url)) {
    return resolvedUrlCache.get(url)!;
  }
  try {
    const res = await safeRequest(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Range': 'bytes=0-0',
      },
    });
    res.body.destroy();
    const finalUrl = res.url || url;
    if (res.status < 400 && finalUrl !== url) {
      resolvedUrlCache.set(url, finalUrl);
      console.log('[Resolver] URL da CDN resolvida:', redactUrl(finalUrl));
    }
    return finalUrl;
  } catch (err: any) {
    if (isBlockedError(err)) throw err;
    console.warn('[Resolver] Falha ao resolver URL final, usando original:', err?.message);
    return url;
  }
}
