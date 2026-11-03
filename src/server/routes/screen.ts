import type { IncomingMessage, ServerResponse } from 'node:http';
import { getAccess } from '../gate';
import { sendApiError, sendJson } from '../http';
import { roomManager } from '../roomServer';
import { relayUrlFor, screenShareEnabled } from '../screenShare';

/**
 * POST /api/screen/token — o endereço do relay (com o token) para transmitir ou assistir a tela da sala.
 * O token de publicar só vai ao Host que transmite; os demais membros recebem o de só assistir. O corpo da
 * resposta carrega um segredo: nunca vai para log nem para cache.
 */
export function handleScreenToken(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendApiError(res, 405, 'method_not_allowed');
  }
  if (!screenShareEnabled()) return sendApiError(res, 503, 'screenshare_disabled');

  const access = getAccess(req);
  if (!access || access.kind !== 'room' || !access.roomId || !access.userId) return sendApiError(res, 403, 'forbidden');

  const screen = roomManager.getScreen(access.roomId);
  if (!screen) return sendApiError(res, 404, 'no_screen');

  const publish = roomManager.isScreenBroadcaster(access.roomId, access.userId);
  if (!publish && !screen.live) return sendApiError(res, 409, 'screen_not_live');

  const url = relayUrlFor(publish ? 'publish' : 'subscribe');
  if (!url) return sendApiError(res, 503, 'screenshare_disabled');

  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, { url, path: screen.path, publish, quality: screen.quality, sessionId: screen.sessionId });
}
