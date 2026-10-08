import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http';
import { getTools } from '../tools';

/** GET /api/status — FFmpeg e Python foram encontrados? Só versões: o caminho no disco não sai do servidor. */
export function handleStatus(_req: IncomingMessage, res: ServerResponse) {
  const { ffmpeg, python } = getTools();
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, {
    ffmpeg: { found: ffmpeg.found, version: ffmpeg.version },
    python: { found: python.found, version: python.version, tooOld: python.tooOld === true },
  });
}
