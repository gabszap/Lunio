import { urlParam } from './linkParam';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { touchCacheFile } from '../cleanup';
import { sendApiError } from '../http';
import { isBlockedError } from '../security';
import { getMediaFingerprint } from '../media/fingerprint';
import { ensureFonts } from '../media/fonts';
import { FONT_CACHE_DIR } from '../media/paths';

/** GET /api/font?url=…&track=… — fonte anexada ao MKV, extraída uma vez e servida do cache. */
export async function handleFont(req: IncomingMessage, res: ServerResponse) {
  try {
    const reqUrl = new URL(req.url || '', 'http://localhost');
    const targetUrl = urlParam(req, res, reqUrl);
    if (targetUrl === false) return; // id de link desconhecido: já respondeu 404
    const fontFilename = reqUrl.searchParams.get('name') || '';
    const streamTrack = reqUrl.searchParams.get('track') || '';
    const customFingerprint = (reqUrl.searchParams.get('fingerprint') || '').slice(0, 200) || undefined;

    if (!targetUrl || !/^\d{1,4}$/.test(streamTrack)) {
      sendApiError(res, 400, 'bad_request', 'Parâmetros url e track são obrigatórios.');
      return;
    }

    const hash = getMediaFingerprint(targetUrl, customFingerprint);
    const targetDir = path.join(FONT_CACHE_DIR, hash);
    fs.mkdirSync(targetDir, { recursive: true });

    // O nome do anexo vem do MKV (dado de terceiros, pode ter `..\`). Por isso o FFmpeg grava só em
    // caminhos que o servidor escolhe (f<índice>.<ext>); o nome original serve apenas para a extensão.

    const findCached = (idx: string): string | null => {
      try {
        const name = fs.readdirSync(targetDir).find((f) => f.startsWith(`f${idx}.`) && !f.endsWith('.done'));
        if (!name) return null;
        const full = path.join(targetDir, name);
        const st = fs.statSync(full);
        return st.isFile() && st.size > 100 ? full : null;
      } catch {
        return null;
      }
    };
    const wasAttempted = (idx: string) => fs.existsSync(path.join(targetDir, `f${idx}.done`));

    const serveCachedFont = (filePath: string) => {
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.otf' ? 'font/otf' : (ext === '.woff2' ? 'font/woff2' : 'font/ttf');
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      touchCacheFile(filePath);
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => {
        if (!res.headersSent) sendApiError(res, 500, 'internal');
        else res.end();
      });
      stream.pipe(res);
    };

    const notFound = () => sendApiError(res, 404, 'not_found', 'Fonte não encontrada no container MKV');

    const cached = findCached(streamTrack);
    if (cached) return serveCachedFont(cached);
    if (wasAttempted(streamTrack)) return notFound();

    // Extrações simultâneas da mesma mídia esperam a mesma (dentro de ensureFonts)
    await ensureFonts(targetUrl, hash, targetDir, { idx: streamTrack, name: fontFilename });
    const afterWait = findCached(streamTrack);
    if (afterWait) return serveCachedFont(afterWait);
    if (wasAttempted(streamTrack)) return notFound();

    notFound();
  } catch (err: any) {
    if (isBlockedError(err)) {
      sendApiError(res, 403, 'url_blocked');
    } else if (err?.code === 'busy') {
      res.setHeader('Retry-After', '5');
      sendApiError(res, 503, 'busy');
    } else {
      console.error('[FontExtractor] Erro:', err?.message);
      sendApiError(res, 500, 'internal');
    }
  }
}
