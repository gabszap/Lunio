import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendApiError, sendJson } from '../http';
import { isBlockedError } from '../security';
import { HlsError, getPlan, getSegmentFile, startHls } from '../media/hls';
import { buildPlaylist } from '../media/hlsPlan';

/**
 * HLS compartilhado (áudio alternativo):
 *  - POST /api/hls/start                          { url, audio, fingerprint? } → { playlist }
 *  - GET  /api/hls/<id>/<áudio>/index.m3u8        playlist VOD (segmentos com o mesmo ?t= do pedido)
 *  - GET  /api/hls/<id>/<áudio>/<n>.ts            segmento (gerado sob demanda e compartilhado)
 * Qualquer `HlsError` de `start` significa "não use HLS neste vídeo": o cliente cai no remux contínuo.
 */
export async function handleHls(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // montado em /api/hls

  try {
    if (parts[0] === 'start') {
      if (req.method !== 'POST') return sendApiError(res, 405, 'method_not_allowed');
      const body = await readJson(req);
      const audio = Number(body.audio);
      if (typeof body.url !== 'string' || !Number.isInteger(audio) || audio < 0 || audio > 999) {
        return sendApiError(res, 400, 'bad_request', 'Parâmetros url e audio são obrigatórios.');
      }
      const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.slice(0, 200) : undefined;
      const started = await startHls({ url: body.url, audio, fingerprint });
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, 200, started);
    }

    const [id, audioRaw, file] = parts;
    if (!id || !/^[a-f0-9]{16}$/.test(id) || !/^\d{1,3}$/.test(audioRaw || '') || !file) {
      return sendApiError(res, 404, 'not_found');
    }
    const audio = Number(audioRaw);

    if (file === 'index.m3u8') {
      const token = url.searchParams.get('t');
      const playlist = buildPlaylist(getPlan(id), token ? `?t=${encodeURIComponent(token)}` : '');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(playlist);
      return;
    }

    const segment = /^(\d{1,6})\.ts$/.exec(file);
    if (!segment) return sendApiError(res, 404, 'not_found');
    const path = await getSegmentFile(id, audio, Number(segment[1]));
    const size = fs.statSync(path).size;
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') return void res.end();
    const stream = fs.createReadStream(path);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (err) {
    if (err instanceof HlsError) {
      if (err.status === 503) res.setHeader('Retry-After', '3');
      return sendApiError(res, err.status, err.code, err.message);
    }
    if (isBlockedError(err)) return sendApiError(res, 403, 'url_blocked');
    console.error('[HLS] Erro:', (err as Error)?.message);
    sendApiError(res, 500, 'internal');
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 8192) {
        req.destroy();
        reject(new HlsError('bad_request', 400));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new HlsError('bad_request', 400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}
