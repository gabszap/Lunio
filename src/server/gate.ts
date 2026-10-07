import type { IncomingMessage, ServerResponse } from 'node:http';
import { issueSoloToken, tokenFromRequest, verifyToken } from './access';
import { handleCors } from './cors';
import { sendApiError, sendJson } from './http';
import { checkRate, clientIp, type RateRule } from './limits';
import { roomManager } from './roomServer';
import { getTools } from './tools';

/**
 * Porta de entrada de /api/*: CORS → rate limit por IP → token de sessão.
 * Fica registrada antes de todas as rotas, então nenhuma rota esquece de checar.
 */

export interface Access {
  kind: 'solo' | 'room';
  roomId?: string;
  userId?: string;
}

const accessByRequest = new WeakMap<IncomingMessage, Access>();

/** Quem fez a chamada (preenchido pelo `apiGate` nas rotas que exigem token). */
export function getAccess(req: IncomingMessage): Access | undefined {
  return accessByRequest.get(req);
}

type AuthMode = 'none' | 'any' | 'host';

const MIN = 60_000;
const ROUTES: Record<string, { auth: AuthMode; rate: RateRule }> = {
  session: { auth: 'none', rate: { max: 30, windowMs: MIN } },
  room: { auth: 'none', rate: { max: 120, windowMs: MIN } },
  token: { auth: 'none', rate: { max: 20, windowMs: MIN } },
  status: { auth: 'none', rate: { max: 30, windowMs: MIN } },
  proxy: { auth: 'any', rate: { max: 900, windowMs: MIN } },
  resolve: { auth: 'any', rate: { max: 60, windowMs: MIN } },
  tracks: { auth: 'any', rate: { max: 30, windowMs: MIN } },
  subtitle: { auth: 'any', rate: { max: 60, windowMs: MIN } },
  font: { auth: 'any', rate: { max: 300, windowMs: MIN } },
  drive: { auth: 'any', rate: { max: 20, windowMs: MIN } },
  upload: { auth: 'host', rate: { max: 10, windowMs: 10 * MIN } },
  uploads: { auth: 'any', rate: { max: 600, windowMs: MIN } },
};

export function apiGate(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
  const url = new URL(req.url || '', 'http://localhost');
  const match = /^\/api\/([a-z]+)(?:\/|$)/.exec(url.pathname);
  if (!match) return next();

  if (!handleCors(req, res)) return;

  const route = ROUTES[match[1]];
  if (!route) return next();

  const waitSeconds = checkRate(clientIp(req), match[1], route.rate);
  if (waitSeconds !== null) {
    res.setHeader('Retry-After', String(waitSeconds));
    return sendApiError(res, 429, 'rate_limited');
  }

  if (route.auth === 'none') return next();

  const payload = verifyToken(tokenFromRequest(req, url));
  if (!payload) return sendApiError(res, 401, 'unauthorized');

  if (payload.k === 'room') {
    // O token só vale enquanto a pessoa continua na sala (expulsão/banimento o invalida)
    if (!roomManager.isMember(payload.r, payload.u)) return sendApiError(res, 401, 'unauthorized');
    accessByRequest.set(req, { kind: 'room', roomId: payload.r, userId: payload.u });
  } else {
    accessByRequest.set(req, { kind: 'solo' });
  }

  if (route.auth === 'host') {
    const access = accessByRequest.get(req)!;
    if (access.kind !== 'room' || !roomManager.isHostMember(access.roomId!, access.userId!)) {
      return sendApiError(res, 403, 'not_host');
    }
  }
  next();
}

/** POST /api/session — token para quem assiste sozinho (a sala usa o do WebSocket). */
export function handleSession(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') return sendApiError(res, 405, 'method_not_allowed');
  const { token, expiresAt } = issueSoloToken();
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, { token, expiresAt });
}

/** GET /api/status — FFmpeg e Python foram encontrados? Só versões: o caminho no disco não sai do servidor. */
export function handleStatus(_req: IncomingMessage, res: ServerResponse) {
  const { ffmpeg, python } = getTools();
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, {
    ffmpeg: { found: ffmpeg.found, version: ffmpeg.version },
    python: { found: python.found, version: python.version, tooOld: python.tooOld === true },
  });
}
