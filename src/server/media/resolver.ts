import { redactUrl } from '../http';
import { assertPublicUrl, isBlockedError, safeRequest } from '../security';

/**
 * URL original (Torrentio/debrid) → URL final da CDN, já validada contra SSRF.
 *
 * A entrada é uma decisão, não só o endereço: se a URL já é a da CDN (não redireciona),
 * guardar `url → url` evita que CADA requisição de Range do player repita a sondagem `bytes=0-0`.
 */
export const resolvedUrlCache = new Map<string, string>();

/**
 * TTL curto de propósito: URL assinada do TorBox expira em minutos, e o proxy só é lento
 * enquanto a entrada bate. Pequeno o bastante para re-resolver rápido depois de expirar,
 * grande o bastante para o player não re-sondar a cada Range.
 */
const RESOLVED_TTL_MS = 5 * 60_000;
const RESOLVED_MAX_ENTRIES = 500;

const resolvedAt = new Map<string, number>();

function cacheResolved(target: string, final: string) {
  resolvedUrlCache.set(target, final);
  resolvedAt.set(target, Date.now());
  // Map simples não expira sozinho: sem este teto, cada URL já vista ficaria na memória do processo para sempre.
  if (resolvedUrlCache.size > RESOLVED_MAX_ENTRIES) {
    const oldest = [...resolvedAt.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) {
      resolvedUrlCache.delete(oldest[0]);
      resolvedAt.delete(oldest[0]);
    }
  }
}

function invalidate(target: string) {
  resolvedUrlCache.delete(target);
  resolvedAt.delete(target);
}

function isFresh(target: string): boolean {
  const at = resolvedAt.get(target);
  return at !== undefined && Date.now() - at < RESOLVED_TTL_MS;
}

/**
 * Single-flight: várias requisições de Range do MESMO vídeo chegam juntas (o player abre
 * janelas em paralelo). Sem isto, todas sairiam do cache frio ao mesmo tempo e fariam a
 * sondagem `bytes=0-0` em paralelo — N idas extras ao CDN no pior momento possível.
 */
const inflight = new Map<string, Promise<string>>();

export async function resolveFinalCdnUrl(url: string): Promise<string> {
  // Lança UrlBlockedError se a URL (ou algum redirecionamento) apontar para rede interna
  await assertPublicUrl(url);
  if (isFresh(url)) {
    return resolvedUrlCache.get(url)!;
  }
  const pending = inflight.get(url);
  if (pending) return pending;

  const task = probeFinalCdnUrl(url).finally(() => inflight.delete(url));
  inflight.set(url, task);
  return task;
}

async function probeFinalCdnUrl(url: string): Promise<string> {
  invalidate(url);
  try {
    const res = await safeRequest(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Range': 'bytes=0-0',
      },
    });
    res.body.destroy();
    const finalUrl = res.url || url;
    if (res.status < 400) {
      // Guarda também quando não houve redirect: `url → url` é a informação que impede
      // a sondagem `bytes=0-0` de se repetir em cada requisição de Range do mesmo vídeo.
      cacheResolved(url, finalUrl);
      if (finalUrl !== url) {
        console.log('[Resolver] URL da CDN resolvida:', redactUrl(finalUrl));
      }
    }
    return finalUrl;
  } catch (err: any) {
    if (isBlockedError(err)) throw err;
    console.warn('[Resolver] Falha ao resolver URL final, usando original:', err?.message);
    return url;
  }
}

export { invalidate as invalidateResolvedUrl, cacheResolved };