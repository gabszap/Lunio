import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { roomManager } from './roomServer';

/**
 * Rotas de apoio às fontes de vídeo da Home:
 *  - GET  /api/room?id=CODE         → a sala existe? foi encerrada?
 *  - POST /api/upload?name=arquivo  → recebe o arquivo (corpo cru) e grava em .uploads/
 *  - GET  /api/uploads/<id>/<nome>  → serve o arquivo enviado com suporte a Range (206)
 *  - GET  /api/drive?url=<link>     → resolve um link de compartilhamento do Google Drive
 */

const UPLOAD_DIR = path.resolve(process.cwd(), '.uploads');
export const MAX_UPLOAD_BYTES = 50 * 1024 ** 3; // 50 GB

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function safeFileName(name: string): string {
  const base = path.basename(name || 'video').replace(/[^\w.\-()[\] ]+/g, '_').trim();
  return base.slice(0, 180) || 'video';
}

// ───────────── /api/room ─────────────

export function handleRoomInfo(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '', 'http://localhost');
  const id = (url.searchParams.get('id') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,32}$/.test(id)) {
    sendJson(res, 400, { error: 'invalid_code' });
    return;
  }
  sendJson(res, 200, roomManager.getRoomInfo(id));
}

// ───────────── /api/upload ─────────────

export function handleUpload(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const url = new URL(req.url || '', 'http://localhost');
  const name = safeFileName(url.searchParams.get('name') || 'video');
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES) {
    sendJson(res, 413, { error: 'too_large', limit: MAX_UPLOAD_BYTES });
    req.resume();
    return;
  }

  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(UPLOAD_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  const out = fs.createWriteStream(filePath);
  let received = 0;
  let failed = false;

  const fail = (status: number, error: string) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(dir, { recursive: true, force: true }, () => {});
    if (!res.headersSent) sendJson(res, status, { error });
  };

  req.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) {
      fail(413, 'too_large');
      req.destroy();
    }
  });
  req.on('aborted', () => fail(499, 'aborted'));
  out.on('error', (err) => fail(500, err.message));
  out.on('finish', () => {
    if (failed) return;
    console.log(`[Upload] ✅ ${name} (${(received / 1024 ** 2).toFixed(1)} MB) → ${id}`);
    sendJson(res, 200, { id, name, size: received, url: `/api/uploads/${id}/${encodeURIComponent(name)}` });
  });
  req.pipe(out);
}

// ───────────── /api/uploads/<id>/<nome> ─────────────

export function handleUploadServe(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '', 'http://localhost');
  // Montado em /api/uploads, então pathname = /<id>/<nome>
  const [id, rawName] = url.pathname.split('/').filter(Boolean);
  if (!id || !/^[a-f0-9]{16}$/.test(id) || !rawName) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const filePath = path.join(UPLOAD_DIR, id, safeFileName(decodeURIComponent(rawName)));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  const total = stat.size;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const range = req.headers.range;
  const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (match) {
    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : total - 1;
    if (!match[1] && match[2]) {
      start = Math.max(0, total - parseInt(match[2], 10));
      end = total - 1;
    }
    if (start >= total || end < start) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${total}`);
      res.end();
      return;
    }
    end = Math.min(end, total - 1);
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Length', String(total));
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(filePath).pipe(res);
}

// ───────────── /api/drive ─────────────

export function getDriveFileId(link: string): string | null {
  const trimmed = (link || '').trim();
  const byPath = /\/(?:file\/)?d\/([\w-]{10,})/.exec(trimmed);
  if (byPath) return byPath[1];
  try {
    const u = new URL(trimmed);
    const id = u.searchParams.get('id');
    if (id && /^[\w-]{10,}$/.test(id)) return id;
  } catch {
    // não é URL
  }
  return /^[\w-]{25,}$/.test(trimmed) ? trimmed : null;
}

function parseSize(contentRange: string | null, contentLength: string | null): number {
  const total = contentRange ? /\/(\d+)$/.exec(contentRange) : null;
  if (total) return Number(total[1]);
  return Number(contentLength || 0);
}

function parseFileName(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) return decodeURIComponent(star[1]);
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1] : null;
}

async function probe(url: string) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Range: 'bytes=0-0' } });
  const type = r.headers.get('content-type') || '';
  return { r, type, finalUrl: r.url || url };
}

export async function handleDrive(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '', 'http://localhost');
  const id = getDriveFileId(url.searchParams.get('url') || '');
  if (!id) {
    sendJson(res, 400, { error: 'invalid_link' });
    return;
  }

  try {
    let downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download`;
    let { r, type, finalUrl } = await probe(downloadUrl);

    const noAccess = () => /accounts\.google\.com|ServiceLogin/.test(finalUrl) || r.status === 401 || r.status === 403 || r.status === 404;

    if (!noAccess() && type.includes('text/html')) {
      // Arquivos grandes: o Drive mostra a página "não foi possível verificar vírus" com um formulário de confirmação
      const html = await r.text();
      const field = (n: string) => new RegExp(`name="${n}"\\s+value="([^"]*)"`).exec(html)?.[1];
      const confirm = field('confirm');
      const uuid = field('uuid');
      if (!confirm) {
        sendJson(res, 403, { error: 'no_access' });
        return;
      }
      downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=${encodeURIComponent(confirm)}${
        uuid ? `&uuid=${encodeURIComponent(uuid)}` : ''
      }`;
      ({ r, type, finalUrl } = await probe(downloadUrl));
    } else {
      r.body?.cancel().catch(() => {});
    }

    if (noAccess() || type.includes('text/html') || !r.ok) {
      r.body?.cancel().catch(() => {});
      sendJson(res, 403, { error: 'no_access' });
      return;
    }
    r.body?.cancel().catch(() => {});

    sendJson(res, 200, {
      id,
      url: downloadUrl,
      name: parseFileName(r.headers.get('content-disposition')) || `drive-${id}`,
      size: parseSize(r.headers.get('content-range'), r.headers.get('content-length')),
      mimeType: type.split(';')[0] || 'video/mp4',
    });
  } catch (err: any) {
    sendJson(res, 502, { error: 'unreachable', message: err?.message });
  }
}
