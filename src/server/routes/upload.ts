import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { getAccess } from '../gate';
import { issueUploadClaim, verifyToken } from '../access';
import { sendApiError, sendJson } from '../http';
import { roomManager } from '../roomServer';
import { touchCacheFile } from '../cleanup';
import { MIME_BY_EXT, pruneRoomUploads, safeFileName, UPLOAD_DIR, UPLOAD_META, uploadsInProgress, writeUploadMeta } from '../media/uploads';
import { uploadIndex } from '../media/uploadIndex';

/** Salas com um envio em andamento (1 por vez por sala). */
const roomsUploading = new Set<string>();
/** Bytes que os envios em andamento ainda vão escrever (declarados − já recebidos). */
const pendingBytes = new Map<string, number>();

// ───────────── envio em pedaços (resiste ao limite de corpo do proxy e permite retomar) ─────────────

/** Um envio em pedaços: o arquivo cresce no disco, `received` só conta o que já foi confirmado inteiro. */
interface UploadSession {
  id: string;
  roomId: string;
  ownerId: string;
  name: string;
  size: number;
  received: number;
  dir: string;
  file: string;
  lastActivity: number;
  writing: boolean;
}
const sessions = new Map<string, UploadSession>();
/** Sessão sem nenhum pedaço há tanto tempo é abandonada (o espaço reservado volta para a cota). */
const SESSION_IDLE_MS = 60 * 60 * 1000;
/** Nenhum pedaço pode passar disto, quaisquer que sejam as configurações (teto de corpo do proxy). */
const MAX_CHUNK_BYTES = 96 * 1024 * 1024;

function writeSessionMeta(s: UploadSession, complete: boolean) {
  writeUploadMeta(path.join(s.dir, UPLOAD_META), { roomId: s.roomId, name: s.name, createdAt: s.lastActivity, declaredSize: s.size, received: s.received, complete, ownerId: s.ownerId, closedAt: null });
}

function dropSession(s: UploadSession, removeFiles: boolean) {
  sessions.delete(s.id);
  uploadsInProgress.delete(s.id);
  roomsUploading.delete(s.roomId);
  // Síncrono: uma consulta logo depois não pode reencontrar a pasta no disco e ressuscitar a sessão
  if (removeFiles) fs.rmSync(s.dir, { recursive: true, force: true });
}

function expireStaleSessions(now = Date.now()) {
  for (const s of Array.from(sessions.values())) {
    if (!s.writing && now - s.lastActivity > SESSION_IDLE_MS) dropSession(s, true);
  }
}

/** A sessão, da memória ou (depois de um restart do servidor) reconstruída do disco; só para a sala dona dela. */
function findSession(id: string, roomId: string): UploadSession | null {
  const live = sessions.get(id);
  if (live) return live.roomId === roomId ? live : null;
  try {
    const dir = path.join(UPLOAD_DIR, id);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, UPLOAD_META), 'utf-8'));
    if (meta.complete !== false || meta.roomId !== roomId) return null;
    const name = safeFileName(String(meta.name || 'video'));
    const s: UploadSession = {
      id,
      roomId,
      ownerId: typeof meta.ownerId === 'string' ? meta.ownerId : '',
      name,
      size: Number(meta.declaredSize) || 0,
      received: Math.max(0, Number(meta.received) || 0),
      dir,
      file: path.join(dir, name),
      lastActivity: Date.now(),
      writing: false,
    };
    if (!s.size) return null;
    sessions.set(id, s);
    uploadsInProgress.add(id);
    roomsUploading.add(roomId);
    return s;
  } catch {
    return null;
  }
}

function jsonBody(res: ServerResponse, status: number, body: unknown) {
  sendJson(res, status, body);
}

function handleStart(req: IncomingMessage, res: ServerResponse, roomId: string, ownerId: string) {
  const url = new URL(req.url || '', 'http://localhost');
  const name = safeFileName(url.searchParams.get('name') || 'video');
  const size = Number(url.searchParams.get('size'));
  if (!Number.isInteger(size) || size <= 0) return sendApiError(res, 400, 'bad_request');
  if (size > config.maxUploadFileBytes) return sendApiError(res, 413, 'too_large');

  expireStaleSessions();
  // Um envio parado da mesma sala (aba fechada, conexão perdida) não pode travar o próximo: é substituído.
  // Só um que recebeu pedaço agora há pouco conta como "em andamento".
  for (const s of Array.from(sessions.values())) {
    if (s.roomId !== roomId) continue;
    if (s.writing || Date.now() - s.lastActivity < 15_000) return sendApiError(res, 409, 'upload_in_progress');
    dropSession(s, true);
  }
  if (roomsUploading.has(roomId)) return sendApiError(res, 409, 'upload_in_progress'); // envio inteiro (antigo) em curso

  const used = uploadsDiskUsage() + pendingTotal();
  if (used + size > config.maxUploadDiskBytes) {
    if (size > config.maxUploadDiskBytes) {
      // O arquivo sozinho é maior que TODA a cota do servidor: nenhum espaço livre o acomodaria
      console.warn(`[Upload] Arquivo maior que a cota de envios (${Math.round(config.maxUploadDiskBytes / 1024 ** 3)} GB); envio recusado.`);
      return sendApiError(res, 413, 'file_over_quota');
    }
    console.warn('[Upload] Cota de disco cheia; envio recusado.');
    return sendApiError(res, 507, 'quota_exceeded');
  }
  if (diskTooFull(size)) {
    console.warn('[Upload] Pouco espaço livre no disco; envio recusado.');
    return sendApiError(res, 507, 'quota_exceeded');
  }

  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(UPLOAD_DIR, id);
  const file = path.join(dir, name);
  if (path.dirname(file) !== dir) return sendApiError(res, 400, 'bad_request');
  fs.mkdirSync(dir, { recursive: true });
  const s: UploadSession = { id, roomId, ownerId, name, size, received: 0, dir, file, lastActivity: Date.now(), writing: false };
  try {
    writeSessionMeta(s, false);
    fs.writeFileSync(file, '');
  } catch (err) {
    console.error('[Upload] Não foi possível iniciar o envio:', err);
    fs.rmSync(dir, { recursive: true, force: true });
    return sendApiError(res, 500, 'internal');
  }
  sessions.set(id, s);
  uploadsInProgress.add(id);
  roomsUploading.add(roomId);
  console.log(`[Upload] Envio iniciado: ${name} (${(size / 1024 ** 2).toFixed(1)} MB) → ${id} (sala ${roomId})`);
  jsonBody(res, 200, { id, chunkSize: Math.min(config.uploadChunkBytes, MAX_CHUNK_BYTES), received: 0, claim: issueUploadClaim(id, ownerId) });
}

function handleChunk(req: IncomingMessage, res: ServerResponse, s: UploadSession) {
  const refuse = (status: number, code: string, extra: object = {}) => {
    if (!res.headersSent) res.statusCode = status;
    sendApiError(res, status, code, undefined, extra);
    req.resume();
  };
  const url = new URL(req.url || '', 'http://localhost');
  const offset = Number(url.searchParams.get('offset'));
  const length = Number(req.headers['content-length'] || 0);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) return refuse(400, 'bad_request');
  if (length > MAX_CHUNK_BYTES) return refuse(413, 'too_large');
  if (s.writing) return refuse(409, 'upload_in_progress');
  // O cliente e o servidor discordam de onde o arquivo está: devolve o ponto certo para ele continuar dali
  if (offset !== s.received) return refuse(409, 'offset_mismatch', { received: s.received });
  if (offset + length > s.size) return refuse(413, 'too_large');

  // Sobra de um pedaço anterior que não terminou (conexão cortada no meio): volta o arquivo ao que foi confirmado
  try {
    if (!fs.existsSync(s.file)) fs.writeFileSync(s.file, '');
    if (fs.statSync(s.file).size > s.received) fs.truncateSync(s.file, s.received);
  } catch (err) {
    console.error('[Upload] Erro ao preparar o pedaço:', err);
    return refuse(500, 'internal');
  }

  s.writing = true;
  s.lastActivity = Date.now();
  const out = fs.createWriteStream(s.file, { flags: 'a' });
  let got = 0;
  let settled = false;
  const abort = (status: number, code: string) => {
    if (settled) return;
    settled = true;
    s.writing = false;
    out.destroy();
    if (!res.headersSent && !res.writableEnded) refuse(status, code);
  };
  req.on('data', (chunk: Buffer) => {
    got += chunk.length;
    if (got > length) {
      abort(413, 'too_large');
      req.destroy();
    }
  });
  req.on('aborted', () => abort(499, 'bad_request'));
  req.on('error', () => abort(499, 'bad_request'));
  out.on('error', (err) => {
    console.error('[Upload] Erro de escrita:', err);
    abort(500, 'internal');
  });
  out.on('finish', () => {
    if (settled) return;
    settled = true;
    s.writing = false;
    if (got !== length) return refuse(400, 'bad_request'); // chegou menos do que o declarado
    s.received += got;
    s.lastActivity = Date.now();
    try {
      writeSessionMeta(s, false);
    } catch {
      // a posição também vale em memória; só não sobrevive a um restart
    }
    jsonBody(res, 200, { received: s.received });
  });
  req.pipe(out);
}

function handleFinish(res: ServerResponse, s: UploadSession) {
  if (s.writing) return sendApiError(res, 409, 'upload_in_progress');
  if (s.received !== s.size) return sendApiError(res, 409, 'offset_mismatch', undefined, { received: s.received });
  try {
    writeSessionMeta(s, true);
  } catch (err) {
    console.error('[Upload] Não foi possível concluir o envio:', err);
    return sendApiError(res, 500, 'internal');
  }
  dropSession(s, false);
  console.log(`[Upload] ${s.name} (${(s.size / 1024 ** 2).toFixed(1)} MB) → ${s.id} (sala ${s.roomId})`);
  // Uma sala, um envio: o que a sala não está usando (e não é este) sai agora
  pruneRoomUploads(s.roomId, new Set([...roomManager.referencedUploadIds(s.roomId), s.id]));
  jsonBody(res, 200, { id: s.id, name: s.name, size: s.size, url: `/api/uploads/${s.id}/${encodeURIComponent(s.name)}`, claim: issueUploadClaim(s.id, s.ownerId) });
}

/** /api/upload/*: envio inteiro (antigo), início, pedaços, estado, conclusão e cancelamento. Só o Host da sala. */
export function handleUploadApi(req: IncomingMessage, res: ServerResponse) {
  const access = getAccess(req);
  if (!access || access.kind !== 'room' || !roomManager.isHostMember(access.roomId!, access.userId!)) {
    sendApiError(res, 403, 'not_host');
    req.resume();
    return;
  }
  const roomId = access.roomId!;
  const pathname = new URL(req.url || '', 'http://localhost').pathname; // montado em /api/upload: "/", "/start", "/<id>"…
  const parts = pathname.split('/').filter(Boolean);

  if (parts.length === 0) {
    if (req.method === 'POST') return handleUpload(req, res);
    return sendApiError(res, 405, 'method_not_allowed');
  }
  if (parts[0] === 'start' && parts.length === 1) {
    if (req.method !== 'POST') return sendApiError(res, 405, 'method_not_allowed');
    return handleStart(req, res, roomId, access.userId!);
  }
  if (!/^[a-f0-9]{16}$/.test(parts[0]) || parts.length > 2) return sendApiError(res, 404, 'not_found');

  const s = findSession(parts[0], roomId);
  if (!s) {
    // O envio já concluiu (o finish tira a sessão do mapa): o DELETE apaga o arquivo via meta no disco
    if (req.method === 'DELETE' && deleteFinishedUpload(parts[0], roomId)) {
      res.statusCode = 204;
      return void res.end();
    }
    req.resume();
    return sendApiError(res, 404, 'not_found');
  }
  if (parts.length === 2) {
    if (parts[1] === 'finish' && req.method === 'POST') return handleFinish(res, s);
    return sendApiError(res, 404, 'not_found');
  }
  if (req.method === 'GET') {
    return jsonBody(res, 200, { received: s.received, size: s.size, chunkSize: Math.min(config.uploadChunkBytes, MAX_CHUNK_BYTES) });
  }
  if (req.method === 'PUT') return handleChunk(req, res, s);
  if (req.method === 'DELETE') {
    if (s.writing) return sendApiError(res, 409, 'upload_in_progress');
    dropSession(s, true);
    res.statusCode = 204;
    return void res.end();
  }
  return sendApiError(res, 405, 'method_not_allowed');
}

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
  expireStaleSessions();
  let sum = 0;
  for (const v of pendingBytes.values()) sum += v;
  for (const s of sessions.values()) sum += Math.max(0, s.size - s.received);
  return sum;
}

/** Apaga um envio já concluído (sem sessão viva) pelo meta no disco. `false` quando não é dele ou sumiu. */
function deleteFinishedUpload(id: string, roomId: string): boolean {
  const dir = path.join(UPLOAD_DIR, id);
  let meta: { roomId: string };
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, UPLOAD_META), 'utf-8')) as { roomId: string };
  } catch {
    return false;
  }
  if (meta.roomId !== roomId) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  uploadIndex.forget(id);
  console.log(`[Upload] Envio concluído apagado: ${id} (sala ${roomId})`);
  return true;
}

/** Espaço livre do disco da máquina depois de gravar `declared` bytes; os envios não podem deixá-lo abaixo do mínimo. */
function diskTooFull(declared: number): boolean {
  try {
    const st = fs.statfsSync(config.rootDir);
    return Number(st.bavail) * Number(st.bsize) - declared < config.minFreeDiskBytes;
  } catch {
    return false; // sem statfs nesta plataforma: vale só a cota da pasta
  }
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
    if (declared > config.maxUploadDiskBytes) {
      // O arquivo sozinho é maior que TODA a cota do servidor: nenhum espaço livre o acomodaria
      console.warn(`[Upload] Arquivo maior que a cota de envios (${Math.round(config.maxUploadDiskBytes / 1024 ** 3)} GB); envio recusado.`);
      return refuse(413, 'file_over_quota');
    }
    console.warn(`[Upload] Cota de disco cheia (${(usedAtStart / 1024 ** 3).toFixed(2)} GB em uso); envio recusado.`);
    return refuse(507, 'quota_exceeded');
  }

  // Além da cota da pasta: o disco da máquina inteira não pode ficar sem folga (o cache e o sistema também precisam)
  if (diskTooFull(declared)) {
    console.warn('[Upload] Pouco espaço livre no disco; envio recusado.');
    return refuse(507, 'quota_exceeded');
  }

  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(UPLOAD_DIR, id);
  const filePath = path.join(dir, name);
  // Defesa em profundidade: o arquivo precisa ficar dentro da pasta do envio
  if (path.dirname(filePath) !== dir) return refuse(400, 'bad_request');

  fs.mkdirSync(dir, { recursive: true });
  try {
    writeUploadMeta(
      path.join(dir, UPLOAD_META),
      { roomId, name, createdAt: Date.now(), declaredSize: declared, ownerId: access.userId, closedAt: null }
    );
  } catch (err) {
    console.error('[Upload] Não foi possível gravar os metadados:', err);
    fs.rmSync(dir, { recursive: true, force: true });
    return refuse(500, 'internal');
  }

  roomsUploading.add(roomId);
  uploadsInProgress.add(id);
  pendingBytes.set(id, declared);
  const out = fs.createWriteStream(filePath);
  let received = 0;
  let settled = false;

  const release = () => {
    roomsUploading.delete(roomId);
    uploadsInProgress.delete(id);
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
    // Uma sala, um envio: o que a sala não está usando (e não é este) sai agora
    pruneRoomUploads(roomId, new Set([...roomManager.referencedUploadIds(roomId), id]));
    sendJson(res, 200, { id, name, size: received, url: `/api/uploads/${id}/${encodeURIComponent(name)}`, claim: issueUploadClaim(id, access.userId) });
  });
  req.pipe(out);
}

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

  // Marca o envio como lido agora (a limpeza por inatividade olha isto), no máximo 1 vez por minuto por envio
  if (uploadIndex.touch(id, Date.now())) touchCacheFile(filePath);

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

/**
 * POST /api/uploads/claim { id, claim } — reabrir um envio (ENVIOS-REDIS.md, 4.6).
 * O navegador guarda o `claim` assinado que recebeu no envio; quem o apresenta recupera o arquivo,
 * mesmo com a sala encerrada (disco confirmado e `complete`): `closedAt` volta a `null` e, quem
 * pedir com token de sala de Host ativa e sala diferente, leva o envio para essa sala (regra
 * "uma sala, um envio" aplicada na sala nova, como em um envio novo).
 */
export async function handleUploadClaim(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendApiError(res, 405, 'method_not_allowed');
    return;
  }
  const access = getAccess(req); // token solo ou de sala de quem pede (habilitado no gate)
  let raw = '';
  let body: { id?: unknown; claim?: unknown } | null = null;
  req.on('data', (c: Buffer) => {
    raw += c.toString();
    if (raw.length > 64 * 1024) raw = '';
  });
  const parse = new Promise<void>((resolve) => req.on('end', resolve));
  await parse;
  try {
    body = JSON.parse(raw || '{}') as { id?: unknown; claim?: unknown };
  } catch {
    sendApiError(res, 400, 'bad_request');
    return;
  }
  const id = typeof body.id === 'string' ? body.id : '';
  const claim = typeof body.claim === 'string' ? body.claim : '';
  const payload = verifyToken(claim);
  if (!id || !/^[a-f0-9]{16}$/.test(id) || !payload || payload.k !== 'upload' || payload.id !== id) {
    sendApiError(res, 403, 'claim_invalid');
    return;
  }

  const dir = path.join(UPLOAD_DIR, id);
  const metaPath = path.join(dir, UPLOAD_META);
  let meta: Record<string, unknown> | null = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // sumiu do disco (envio venceu e saiu na limpeza) ou nunca existiu: o claim não serve
  }
  if (!meta || typeof meta.name !== 'string' || meta.complete === false) {
    sendApiError(res, 404, 'claim_not_found');
    return;
  }

  const fromRoomId = typeof meta.roomId === 'string' ? meta.roomId : undefined;
  let roomId = fromRoomId;
  if (access?.kind === 'room' && roomManager.isHostMember(access.roomId!, access.userId!)) {
    roomId = access.roomId; // reabriu estando numa sala nova: o envio passa a ser dela
  }
  meta.roomId = roomId;
  meta.closedAt = null;
  try {
    writeUploadMeta(metaPath, meta);
  } catch (err) {
    console.error('[Upload] Não foi possível reabrir o envio:', err);
    sendApiError(res, 500, 'internal');
    return;
  }
  if (roomId !== fromRoomId) uploadIndex.moveRoomUpload(id, fromRoomId, roomId!);
  // Uma sala, um envio: vale também no reabrir — a sala que ganha o arquivo não fica guardando os velhos
  if (roomId && roomManager.isRoomActive(roomId)) {
    pruneRoomUploads(roomId, new Set([...roomManager.referencedUploadIds(roomId), id]));
  }
  console.log(`[Upload] Reaberto: ${id} (de ${fromRoomId ?? 'salas perdidas'} → ${roomId})`);
  jsonBody(res, 200, { id, name: meta.name, size: Number(meta.declaredSize) || 0, url: `/api/uploads/${id}/${encodeURIComponent(String(meta.name))}` });
}
