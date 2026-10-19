import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http';
import crypto from 'node:crypto';
import { getCacheStats } from '../cleanup';
import { roomManager } from '../roomServer';
import { getTools } from '../tools';
import { getRedisStatus } from '../media/redis';

/** GET /api/status — FFmpeg e Python foram encontrados? Só versões: o caminho no disco não sai do servidor. Mais: salas, pessoas e tempo no ar. */
export async function handleStatus(_req: IncomingMessage, res: ServerResponse) {
  const { ffmpeg, python } = getTools();
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, {
    ...roomManager.getStats(),
    uptimeSeconds: Math.floor(process.uptime()),
    cache: getCacheStats(),
    ffmpeg: { found: ffmpeg.found, version: ffmpeg.version },
    python: { found: python.found, version: python.version, tooOld: python.tooOld === true },
    redis: await getRedisStatus(),
  });
}

const SPEED_CHUNK = crypto.randomBytes(1024 * 1024);
const SPEED_CHUNKS = 4;

/** GET /api/speed — 4 MiB aleatórios (não comprimem) para a Home medir a velocidade até aqui. */
export function handleSpeed(_req: IncomingMessage, res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(SPEED_CHUNK.length * SPEED_CHUNKS));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  let sent = 0;
  const pump = () => {
    while (sent < SPEED_CHUNKS) {
      sent++;
      if (!res.write(SPEED_CHUNK)) {
        res.once('drain', pump);
        return;
      }
    }
    res.end();
  };
  res.on('close', () => res.removeListener('drain', pump));
  pump();
}
