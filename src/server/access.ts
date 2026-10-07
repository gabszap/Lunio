import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { config } from './config';

/**
 * Tokens de sessão. A API de mídia (proxy, tracks, legendas, envios…) só atende quem apresenta um:
 *  - `room`: emitido pelo WebSocket a cada membro de sala. Vale enquanto a pessoa estiver na sala
 *    (a checagem de pertencimento é feita em `gate.ts`, que conhece o `roomManager`);
 *  - `solo`: emitido por `POST /api/session` para quem assiste sozinho. Expira em 12 h.
 *
 * Os tokens são assinados (HMAC-SHA256), então não há tabela para vazar nem limpar. O cliente envia
 * o token em `?t=` (necessário para `<video src>`) ou no cabeçalho `X-Lunio-Token`.
 */

const SOLO_TTL_MS = 12 * 3600 * 1000;

export type TokenPayload =
  | { k: 'solo'; exp: number; n: string }
  | { k: 'room'; r: string; u: string };

const b64u = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

function mac(body: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
}

function sign(payload: TokenPayload): string {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${mac(body)}`;
}

export function issueSoloToken(): { token: string; expiresAt: number } {
  const exp = Date.now() + SOLO_TTL_MS;
  return { token: sign({ k: 'solo', exp, n: crypto.randomBytes(8).toString('hex') }), expiresAt: exp };
}

export function issueRoomToken(roomId: string, userId: string): string {
  return sign({ k: 'room', r: roomId, u: userId });
}

/** Confere assinatura e validade. Não sabe se a pessoa ainda está na sala — isso é do `gate.ts`. */
export function verifyToken(token: string | null | undefined): TokenPayload | null {
  if (!token || token.length > 1024) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(body));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as TokenPayload;
    if (payload.k === 'solo') return typeof payload.exp === 'number' && payload.exp > Date.now() ? payload : null;
    if (payload.k === 'room') return typeof payload.r === 'string' && typeof payload.u === 'string' ? payload : null;
  } catch {
    // payload corrompido
  }
  return null;
}

export function tokenFromRequest(req: IncomingMessage, url?: URL): string | null {
  const header = req.headers['x-lunio-token'];
  if (typeof header === 'string' && header) return header;
  const u = url || new URL(req.url || '', 'http://localhost');
  return u.searchParams.get('t');
}
