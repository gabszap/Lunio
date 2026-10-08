import crypto from 'node:crypto';

/**
 * Identidade da mídia para nomes de arquivo de cache. O cliente manda `fingerprint=` (buildMediaFingerprint);
 * sem ele, cai na URL sem parâmetros efêmeros.
 */
export function getMediaFingerprint(url: string, customFingerprint?: string): string {
  if (customFingerprint && customFingerprint.trim().length > 3) {
    return crypto.createHash('sha1').update(customFingerprint.trim()).digest('hex').slice(0, 16);
  }
  try {
    const parsed = new URL(url);
    // Remove apenas parâmetros efêmeros de autenticação/expiração conhecidos
    const ephemeralParams = ['token', 'expires', 'auth', 'api_key', 'session', 'ts', 'hmac', 'sig', 'signature', 'expiry'];
    for (const param of ephemeralParams) {
      parsed.searchParams.delete(param);
    }
    const normalizedUrl = parsed.origin + parsed.pathname + (parsed.search ? parsed.search : '');
    return crypto.createHash('sha1').update(normalizedUrl).digest('hex').slice(0, 16);
  } catch {
    return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  }
}

export function extractFilenameFromUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    const parts = parsed.pathname.split('/').map((p) => {
      try { return decodeURIComponent(p); } catch { return p; }
    });
    // Procura na ordem reversa algum segmento que termine com extensão de vídeo
    const mediaPart = parts.slice().reverse().find((p) => /\.(mkv|mp4|avi|webm|mov|m4v|ts)$/i.test(p));
    if (mediaPart) return mediaPart;
    // Caso não tenha extensão explícita, pega o último segmento não vazio
    const lastPart = parts.filter(Boolean).pop();
    return lastPart || '';
  } catch {
    return '';
  }
}
