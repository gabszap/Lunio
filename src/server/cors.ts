import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config';

/**
 * CORS restrito: a API só responde a páginas da própria origem, às de `ALLOWED_ORIGINS` e à Discord
 * Activity (`https://<client_id>.discordsays.com`). Antes era `Access-Control-Allow-Origin: *` em tudo.
 */

const discordOrigin = `https://${config.discordClientId}.discordsays.com`;

function requestHost(headers: IncomingHttpHeaders): string {
  const fwd = headers['x-forwarded-host'];
  const forwarded = Array.isArray(fwd) ? fwd[0] : fwd;
  return ((config.trustProxy && forwarded) || headers.host || '').split(',')[0].trim().toLowerCase();
}

/** Sem cabeçalho `Origin` (curl, `<video>`, mesma origem em GET) = permitido: quem protege é o token. */
export function isOriginAllowed(origin: string | undefined, headers: IncomingHttpHeaders): boolean {
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.host.toLowerCase() === requestHost(headers)) return true;
  const normalized = parsed.origin;
  return normalized === discordOrigin || config.allowedOrigins.includes(normalized);
}

/**
 * Aplica CORS a uma chamada de /api. Retorna `false` quando a resposta já foi enviada
 * (origem recusada ou preflight respondido).
 */
export function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!isOriginAllowed(origin, req.headers)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Origem não autorizada.', code: 'forbidden' }));
    return false;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, X-Lunio-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Range, Content-Length, Accept-Ranges, X-MediaRun-Session, X-MediaRun-Generation, X-MediaRegion-Start'
    );
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return false;
  }
  return true;
}
