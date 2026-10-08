import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { getAccess } from './gate';
import { sendApiError, sendJson } from './http';
import { readText, safeRequest, UrlBlockedError, type SafeResponse } from './security';
import { roomManager } from './roomServer';

/**
 * Rotas de apoio às fontes de vídeo da Home:
 *  - GET  /api/room?id=CODE         → a sala existe? foi encerrada?
 *  - POST /api/upload?name=arquivo  → recebe o arquivo (corpo cru) e grava em .uploads/ (só o Host de uma sala ativa)
 *  - GET  /api/uploads/<id>/<nome>  → serve o arquivo enviado com suporte a Range (206)
 *  - GET  /api/drive?url=<link>     → resolve um link de compartilhamento do Google Drive
 */

export const UPLOAD_DIR = path.resolve(process.cwd(), '.uploads');
export const UPLOAD_META = '.meta.json';

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

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Nome de arquivo seguro: sem caminho, sem ponto no início, sem nomes reservados do Windows. Idempotente. */
export function safeFileName(name: string): string {
  let base = path
    .basename((name || '').replace(/\\/g, '/'))
    .replace(/[^\w.\-()[\] ]+/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 180)
    .trim();
  if (!base || WINDOWS_RESERVED.test(base)) base = `video${base ? `_${base}` : ''}`;
  return base;
}

// ───────────── /api/room ─────────────

export function handleRoomInfo(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '', 'http://localhost');
  const id = (url.searchParams.get('id') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,32}$/.test(id)) {
    sendApiError(res, 400, 'bad_request', 'Código de sala inválido.');
    return;
  }
  sendJson(res, 200, roomManager.getRoomInfo(id));
}

// ───────────── /api/upload ─────────────

/** Salas com um envio em andamento (1 por vez por sala). */
const roomsUploading = new Set<string>();
/** Bytes que os envios em andamento ainda vão escrever (declarados − já recebidos). */
const pendingBytes = new Map<string, number>();

/** Tamanho total de `.uploads/` no disco (inclui os envios em andamento, que já estão parcialmente gravados). */
export function uploadsDiskUsage(): number {
  let total = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          // arquivo sumiu no meio da varredura
        }
      }
    }
  };
  walk(UPLOAD_DIR);
  return total;
}

function pendingTotal(): number {
  let sum = 0;
  for (const v of pendingBytes.values()) sum += v;
  return sum;
}

export function handleUpload(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendApiError(res, 405, 'method_not_allowed');
    return;
  }
  const refuse = (status: number, code: string) => {
    sendApiError(res, status, code);
    req.resume();
  };

  const access = getAccess(req);
  // O gate já exigiu "Host de sala ativa"; conferimos de novo porque aqui é onde o disco é gasto
  if (!access || access.kind !== 'room' || !roomManager.isHostMember(access.roomId!, access.userId!)) {
    return refuse(403, 'not_host');
  }
  const roomId = access.roomId!;

  const url = new URL(req.url || '', 'http://localhost');
  const name = safeFileName(url.searchParams.get('name') || 'video');
  const declared = Number(req.headers['content-length'] || 0);
  if (!Number.isFinite(declared) || declared <= 0) {
    return refuse(411, 'bad_request');
  }
  if (declared > config.maxUploadFileBytes) {
    return refuse(413, 'too_large');
  }
  if (roomsUploading.has(roomId)) {
    return refuse(409, 'upload_in_progress');
  }
  const usedAtStart = uploadsDiskUsage();
  if (usedAtStart + pendingTotal() + declared > config.maxUploadDiskBytes) {
    console.warn(`[Upload] Cota de disco cheia (${(usedAtStart / 1024 ** 3).toFixed(2)} GB em uso); envio recusado.`);
    return refuse(507, 'quota_exceeded');
  }

  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(UPLOAD_DIR, id);
  const filePath = path.join(dir, name);
  // Defesa em profundidade: o arquivo precisa ficar dentro da pasta do envio
  if (path.dirname(filePath) !== dir) return refuse(400, 'bad_request');

  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(
      path.join(dir, UPLOAD_META),
      JSON.stringify({ roomId, name, createdAt: Date.now(), declaredSize: declared })
    );
  } catch (err) {
    console.error('[Upload] Não foi possível gravar os metadados:', err);
    fs.rmSync(dir, { recursive: true, force: true });
    return refuse(500, 'internal');
  }

  roomsUploading.add(roomId);
  pendingBytes.set(id, declared);
  const out = fs.createWriteStream(filePath);
  let received = 0;
  let settled = false;

  const release = () => {
    roomsUploading.delete(roomId);
    pendingBytes.delete(id);
  };
  const fail = (status: number, code: string) => {
    if (settled) return;
    settled = true;
    release();
    out.destroy();
    fs.rm(dir, { recursive: true, force: true }, () => {});
    if (!res.headersSent) sendApiError(res, status, code);
  };

  req.on('data', (chunk: Buffer) => {
    received += chunk.length;
    pendingBytes.set(id, Math.max(0, declared - received));
    if (received > declared || received > config.maxUploadFileBytes) {
      fail(413, 'too_large');
      req.destroy();
    }
  });
  req.on('aborted', () => fail(499, 'bad_request'));
  req.on('error', () => fail(499, 'bad_request'));
  out.on('error', (err) => {
    console.error('[Upload] Erro de escrita:', err);
    fail(500, 'internal');
  });
  out.on('finish', () => {
    if (settled) return;
    settled = true;
    release();
    console.log(`[Upload] ${name} (${(received / 1024 ** 2).toFixed(1)} MB) → ${id} (sala ${roomId})`);
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
    sendApiError(res, 404, 'not_found');
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawName);
  } catch {
    sendApiError(res, 400, 'bad_request');
    return;
  }
  const filePath = path.join(UPLOAD_DIR, id, safeFileName(decoded));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendApiError(res, 404, 'not_found');
    return;
  }

  const total = stat.size;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');

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

const header = (r: SafeResponse, name: string): string | null => {
  const v = r.headers[name];
  return Array.isArray(v) ? v[0] : v ?? null;
};

function parseSize(contentRange: string | null, contentLength: string | null): number {
  const total = contentRange ? /\/(\d+)$/.exec(contentRange) : null;
  if (total) return Number(total[1]);
  return Number(contentLength || 0);
}

function parseFileName(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return null;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1] : null;
}

async function probe(url: string) {
  const r = await safeRequest(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-0' } });
  return { r, type: header(r, 'content-type') || '', finalUrl: r.url };
}

export async function handleDrive(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '', 'http://localhost');
  const id = getDriveFileId(url.searchParams.get('url') || '');
  if (!id) {
    sendApiError(res, 400, 'bad_request', 'Link do Drive inválido.');
    return;
  }

  try {
    let downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download`;
    let { r, type, finalUrl } = await probe(downloadUrl);

    const noAccess = () => /accounts\.google\.com|ServiceLogin/.test(finalUrl) || r.status === 401 || r.status === 403 || r.status === 404;

    if (!noAccess() && type.includes('text/html')) {
      // Arquivos grandes: o Drive mostra a página "não foi possível verificar vírus" com um formulário de confirmação
      const html = await readText(r.body);
      const field = (n: string) => new RegExp(`name="${n}"\\s+value="([^"]*)"`).exec(html)?.[1];
      const confirm = field('confirm');
      const uuid = field('uuid');
      if (!confirm) {
        sendApiError(res, 403, 'forbidden', 'O arquivo não está compartilhado com acesso por link.');
        return;
      }
      downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=${encodeURIComponent(confirm)}${
        uuid ? `&uuid=${encodeURIComponent(uuid)}` : ''
      }`;
      ({ r, type, finalUrl } = await probe(downloadUrl));
    } else {
      r.body.destroy();
    }

    if (noAccess() || type.includes('text/html') || r.status >= 400) {
      r.body.destroy();
      sendApiError(res, 403, 'forbidden', 'O arquivo não está compartilhado com acesso por link.');
      return;
    }
    r.body.destroy();

    sendJson(res, 200, {
      id,
      url: downloadUrl,
      name: parseFileName(header(r, 'content-disposition')) || `drive-${id}`,
      size: parseSize(header(r, 'content-range'), header(r, 'content-length')),
      mimeType: type.split(';')[0] || 'video/mp4',
    });
  } catch (err) {
    if (err instanceof UrlBlockedError) {
      sendApiError(res, 403, 'url_blocked');
      return;
    }
    console.warn('[Drive] Falha ao consultar o Google Drive:', (err as Error)?.message);
    sendApiError(res, 502, 'upstream_failed', 'Não foi possível falar com o Google Drive.');
  }
}
