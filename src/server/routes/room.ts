import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendApiError, sendJson } from '../http';
import { roomManager } from '../roomServer';

/** GET /api/room?id=CODE — a sala existe? foi encerrada? */
export function handleRoomInfo(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '', 'http://localhost');
  const id = (url.searchParams.get('id') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,32}$/.test(id)) {
    sendApiError(res, 400, 'bad_request', 'Código de sala inválido.');
    return;
  }
  sendJson(res, 200, roomManager.getRoomInfo(id));
}
