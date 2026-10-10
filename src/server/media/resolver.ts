import { performance } from 'node:perf_hooks';
import { assertPublicUrl, isBlockedError, safeRequest } from '../security';

/**
 * Rótulo seguro para log: SÓ o host.
 *
 * `redactUrl` ainda expõe o caminho, e em CDN assinado o token costuma vir no path
 * (`/d/<token>/video.mkv`). Como aqui só precisamos saber "resolveu do host A para o host B",
 * o host basta e não há como vazar credencial no journal.
 */
function hostLabel(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return '(url inválida)';
  }
}

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

type CacheState = 'hit' | 'expirada' | 'miss';

/** 'hit' = utilizável agora; 'expirada' = existe mas passou do TTL (renovação); 'miss' = nunca sondada. */
function cacheState(target: string): CacheState {
  if (!resolvedUrlCache.has(target)) return 'miss';
  const at = resolvedAt.get(target)!;
  return Date.now() - at < RESOLVED_TTL_MS ? 'hit' : 'expirada';
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
  const state = cacheState(url);
  if (state === 'hit') {
    const cached = resolvedUrlCache.get(url)!;
    console.log(`[Resolver] cache=${state} origem=${hostLabel(url)} -> cdn=${hostLabel(cached)} (sem ida ao CDN)`);
    return cached;
  }
  const pending = inflight.get(url);
  if (pending) {
    // Outra janela de Range do MESMO vídeo já está sondando: aproveita a mesma resposta.
    console.log(`[Resolver] cache=coalescido origem=${hostLabel(url)} (sondagem em andamento)`);
    return pending;
  }

  const task = probeFinalCdnUrl(url, state).finally(() => inflight.delete(url));
  inflight.set(url, task);
  return task;
}

async function probeFinalCdnUrl(url: string, state: CacheState): Promise<string> {
  invalidate(url);
  const startedAt = performance.now();
  try {
    const res = await safeRequest(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Range': 'bytes=0-0',
      },
    });
    res.body.destroy();
    const finalUrl = res.url || url;
    const durationMs = performance.now() - startedAt;
    const outcome = res.status < 400 ? 'ok' : 'erro';
    const redirect = finalUrl !== url ? `redirect=${hostLabel(finalUrl)}` : 'redirect=nenhum';

    if (res.status < 400) {
      // Guarda também quando não houve redirect: `url → url` é a informação que impede
      // a sondagem `bytes=0-0` de se repetir em cada requisição de Range do mesmo vídeo.
      cacheResolved(url, finalUrl);
    }
    console.log(
      `[Resolver] cache=${state} origem=${hostLabel(url)} status=${res.status} ${outcome} ${redirect} ` +
        `sondagem=${durationMs.toFixed(1)}ms${res.status < 400 ? '' : ' (NADA foi cacheado)'}`
    );
    return finalUrl;
  } catch (err: any) {
    if (isBlockedError(err)) throw err;
    console.warn(
      `[Resolver] cache=${state} origem=${hostLabel(url)} falha=${err?.message} ` +
        `sondagem=${(performance.now() - startedAt).toFixed(1)}ms (usando a original)`
    );
    return url;
  }
}

export { invalidate as invalidateResolvedUrl, cacheResolved };