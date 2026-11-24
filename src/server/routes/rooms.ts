import type { IncomingMessage, ServerResponse } from 'node:http';
import { getAccess } from '../gate';
import { sendApiError, sendJson } from '../http';
import { PREVIEW_MAX_BYTES, roomManager, type RoomPreviewMimeType } from '../roomServer';

const ROOM_CODE_RE = /^[A-Z0-9]{4,32}$/i;
/** Teto de bytes descartados ao responder 413 antes de derrubar o socket (evita ECONNRESET no cliente e DoS de banda). */
const MAX_DRAIN_AFTER_413 = 1024 * 1024;

function rejectTooLarge(req: IncomingMessage, res: ServerResponse, alreadyRead = 0) {
  let drained = alreadyRead;
  res.setHeader('Connection', 'close');
  sendApiError(res, 413, 'too_large');
  if (req.complete) return;
  const onData = (chunk: Buffer | string) => {
    drained += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (drained > MAX_DRAIN_AFTER_413) {
      req.removeListener('data', onData);
      req.destroy();
    }
  };
  req.on('data', onData);
  req.resume();
}

function isValidImageMagic(buf: Buffer, mimeType: RoomPreviewMimeType): boolean {
  if (mimeType === 'image/jpeg') {
    return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  return (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

function readPreviewBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<{ ok: true; data: Buffer } | { ok: false; reason: 'too_large' | 'aborted' }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: { ok: true; data: Buffer } | { ok: false; reason: 'too_large' | 'aborted' }) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onError);
      resolve(result);
    };

    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        req.pause();
        finish({ ok: false, reason: 'too_large' });
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => finish({ ok: true, data: Buffer.concat(chunks, total) });
    const onError = () => finish({ ok: false, reason: 'aborted' });

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onError);
  });
}

/**
 * Rotas públicas montadas em `/api/rooms`:
 *  - `GET /api/rooms` — lista salas públicas abertas com pessoas conectadas.
 *  - `GET /api/rooms/:code/preview` — serve o preview efêmero em memória de uma sala pública.
 */
export function handlePublicRooms(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendApiError(res, 405, 'method_not_allowed');
  }

  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/' || url.pathname === '') {
    const rooms = roomManager.listPublicRooms();
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, { rooms, total: rooms.length });
  }

  const match = /^\/([^/]+)\/preview\/?$/.exec(url.pathname);
  if (match) {
    let rawCode: string;
    try {
      rawCode = decodeURIComponent(match[1]);
    } catch {
      return sendApiError(res, 404, 'not_found');
    }
    if (!ROOM_CODE_RE.test(rawCode)) {
      return sendApiError(res, 404, 'not_found');
    }
    const preview = roomManager.getRoomPreview(rawCode.toUpperCase());
    if (!preview) {
      return sendApiError(res, 404, 'not_found');
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', preview.mimeType);
    res.setHeader('Content-Length', String(preview.data.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(preview.data);
    return;
  }

  return sendApiError(res, 404, 'not_found');
}

/**
 * Rota montada em `/api/roompreview` (protegida por `auth: 'host'` no `apiGate`):
 *  - `PUT /api/roompreview` — atualiza o preview efêmero (JPEG/WebP <= 64 KiB) da própria sala do Host.
 *  - `DELETE /api/roompreview` — limpa o preview efêmero da sala do Host.
 */
export async function handleUploadRoomPreview(req: IncomingMessage, res: ServerResponse) {
  const access = getAccess(req);
  if (!access || access.kind !== 'room' || !access.roomId) {
    return sendApiError(res, 403, 'forbidden');
  }

  if (req.method === 'DELETE') {
    roomManager.clearRoomPreview(access.roomId);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'PUT') {
    res.setHeader('Allow', 'PUT, DELETE');
    return sendApiError(res, 405, 'method_not_allowed');
  }

  const rawCt = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '';
  const baseCt = rawCt.split(';')[0].trim().toLowerCase();
  if (baseCt !== 'image/jpeg' && baseCt !== 'image/webp') {
    return sendApiError(res, 415, 'unsupported_media_type', 'Tipo de imagem não suportado.');
  }
  const mimeType: RoomPreviewMimeType = baseCt;

  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > PREVIEW_MAX_BYTES) {
    return rejectTooLarge(req, res);
  }

  const body = await readPreviewBody(req, PREVIEW_MAX_BYTES);
  if ('reason' in body) {
    if (body.reason === 'too_large') {
      return rejectTooLarge(req, res, PREVIEW_MAX_BYTES);
    }
    return sendApiError(res, 400, 'bad_request');
  }

  if (!isValidImageMagic(body.data, mimeType)) {
    return sendApiError(res, 400, 'bad_request', 'Imagem inválida.');
  }

  const result = roomManager.setRoomPreview(access.roomId, body.data, mimeType);
  if ('reason' in result) {
    if (result.reason === 'not_found') {
      return sendApiError(res, 404, 'not_found');
    }
    return sendApiError(res, 403, 'forbidden', 'Previews só são permitidos em salas públicas e abertas.');
  }

  res.setHeader('Cache-Control', 'no-store');
  return sendJson(res, 200, { version: result.version });
}
