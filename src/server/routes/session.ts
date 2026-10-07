import type { IncomingMessage, ServerResponse } from 'node:http';
import { issueSoloToken } from '../access';
import { sendApiError, sendJson } from '../http';

/** POST /api/session — token para quem assiste sozinho (a sala usa o do WebSocket). */
export function handleSession(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') return sendApiError(res, 405, 'method_not_allowed');
  const { token, expiresAt } = issueSoloToken();
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, { token, expiresAt });
}
