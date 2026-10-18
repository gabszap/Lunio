import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { roomManager } from './roomServer';
import { UPLOAD_DIR, UPLOAD_META } from './media/uploads';
import { uploadIndex } from './media/uploadIndex';

/**
 * Limpeza automática de disco:
 *  - `.uploads/`: apaga o envio de sala encerrada há mais de `UPLOAD_TTL_HOURS` e o de sala aberta que ninguém lê há
 *    `UPLOAD_IDLE_HOURS`; ao chegar um envio novo, os anteriores da mesma sala saem (media/uploads.ts);
 *  - `.cache/`: apaga o que ficou sem uso além do prazo de cada tipo (legendas 14 dias, fontes 3 dias, HLS 6 h) e,
 *    se ainda passar de `MAX_CACHE_GB`, o que foi usado há mais tempo (LRU).
 */

const CACHE_ROOT = path.resolve(process.cwd(), '.cache');
const SWEEP_EVERY_MS = 15 * 60 * 1000;
/** Arquivos mexidos há menos que isso podem estar sendo gravados agora: não apaga. */
const BUSY_WINDOW_MS = 2 * 60 * 1000;
const startedAt = Date.now();
/** Um envio em pedaços sem nenhum pedaço novo por tanto tempo foi abandonado. */
const ABANDONED_UPLOAD_MS = 60 * 60 * 1000;

/** Marca um arquivo do cache como usado agora (o LRU usa o mtime; atime costuma estar desligado). */
export function touchCacheFile(file: string) {
  const now = new Date();
  fs.utimes(file, now, now, () => {});
}

function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    } catch {
      // sumiu no meio da varredura
    }
  }
  return total;
}

function newestMtime(target: string): number {
  let newest = 0;
  const walk = (p: string) => {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    newest = Math.max(newest, st.mtimeMs);
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name));
  };
  walk(target);
  return newest;
}

/** Envios removidos desde a última passada do cache; a passada do cache fecha o relatório (ver `sweepCache`). */
let pendingUploads = { items: 0, bytes: 0 };
/** Tudo o que a limpeza removeu desde que o servidor subiu. */
const sweepTotals = { items: 0, bytes: 0 };

function removeUploadDir(dir: string) {
  const size = dirSize(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  pendingUploads.items++;
  pendingUploads.bytes += size;
}

export function sweepUploads(
  now = Date.now(),
  dirPath = UPLOAD_DIR,
  ttlMs = config.uploadTtlMs,
  idleMs = config.uploadIdleMs
): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(dirPath, e.name);
    let roomId: string | undefined;
    let createdAt = 0;
    let metaClosedAt: number | undefined;
    let incomplete = false;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, UPLOAD_META), 'utf-8'));
      roomId = typeof meta.roomId === 'string' ? meta.roomId : undefined;
      createdAt = Number(meta.createdAt) || 0;
      if (typeof meta.closedAt === 'number' && meta.closedAt) metaClosedAt = meta.closedAt; // sala reaberta grava `null`
      incomplete = meta.complete === false;
    } catch {
      // envio antigo, sem metadados
    }
    // Envio em pedaços que parou (conexão perdida, aba fechada) e ninguém retomou: não serve para nada e ocupa disco
    if (incomplete && now - newestMtime(dir) > ABANDONED_UPLOAD_MS) {
      removeUploadDir(dir);
      uploadIndex.forget(e.name);
      removed++;
      console.log(`[Limpeza] Envio incompleto ${e.name} removido (parado há mais de 1 h).`);
      continue;
    }
    if (roomId && roomManager.isRoomActive(roomId)) {
      // Sala aberta: o envio fica enquanto alguém lê (cada leitura atualiza a data); sem leitura há `idleMs`, sai
      const idle = now - newestMtime(dir);
      if (idle < idleMs) continue;
      removeUploadDir(dir);
      uploadIndex.forget(e.name);
      removed++;
      console.log(`[Limpeza] Envio ${e.name} removido (sala ${roomId} aberta, mas ninguém o lê há ${Math.round(idle / 3600_000)} h).`);
      continue;
    }
    // Sala encerrada: conta a partir de quando fechou — a sala em memória, depois o `closedAt` gravado no
    // `.meta.json` (sobrevive ao restart). Sem nenhum dos dois: a partir do início do processo (nunca antes do prazo).
    const closedAt = (roomId && roomManager.getClosedAt(roomId)) || metaClosedAt || Math.max(startedAt, createdAt);
    const lastUse = Math.max(closedAt, newestMtime(dir) > now - BUSY_WINDOW_MS ? now : 0);
    if (now - lastUse < ttlMs) continue;
    removeUploadDir(dir);
    uploadIndex.forget(e.name);
    removed++;
    console.log(`[Limpeza] Envio ${e.name} removido (sala ${roomId || 'desconhecida'} encerrada).`);
  }
  return removed;
}

type CacheGroup = 'subtitles' | 'fonts' | 'hls' | 'audio';
const CACHE_GROUPS: CacheGroup[] = ['subtitles', 'fonts', 'hls', 'audio'];

interface CacheUnit {
  path: string;
  group: string;
  size: number;
  mtime: number;
}

/** Unidades de despejo: cada arquivo de legenda/áudio e cada pasta de fontes ou de HLS de uma mídia. */
function cacheUnits(root: string): CacheUnit[] {
  const units: CacheUnit[] = [];
  let groups: fs.Dirent[];
  try {
    groups = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return units;
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const groupDir = path.join(root, g.name);
    for (const e of fs.readdirSync(groupDir, { withFileTypes: true })) {
      const full = path.join(groupDir, e.name);
      try {
        units.push({
          path: full,
          group: g.name,
          size: e.isDirectory() ? dirSize(full) : fs.statSync(full).size,
          mtime: newestMtime(full),
        });
      } catch {
        // sumiu no meio da varredura
      }
    }
  }
  return units;
}

/** Quem precisa saber que uma unidade do cache saiu do disco (ex.: o HLS esquece o plano em memória). */
const removalListeners = new Set<(unitPath: string) => void>();
export function onCacheUnitRemoved(listener: (unitPath: string) => void) {
  removalListeners.add(listener);
}

function removeUnit(unit: CacheUnit) {
  fs.rmSync(unit.path, { recursive: true, force: true });
  for (const listener of removalListeners) {
    try {
      listener(unit.path);
    } catch {
      // um ouvinte com defeito não impede a limpeza
    }
  }
}

export interface SweepReport {
  at: number;
  /** Itens removidos por idade, por estouro do limite de tamanho, e quanto isso liberou. */
  byAge: number;
  byLimit: number;
  /** Envios de vídeo removidos (`.uploads/`) nesta passada. */
  uploads: number;
  /** Bytes liberados no cache e nos envios. */
  freedBytes: number;
}
let lastSweep: SweepReport | null = null;

/**
 * Duas regras, nesta ordem:
 *  1. idade: o que ficou sem uso além do prazo do seu tipo (`config.cacheMaxAgeMs`) sai, mesmo com disco sobrando;
 *  2. tamanho: se ainda passar de `MAX_CACHE_GB`, sai o menos usado (LRU) até caber.
 * Nada mexido há menos de 2 min é apagado (pode estar sendo gravado).
 */
export function sweepCache(
  now = Date.now(),
  root = CACHE_ROOT,
  maxAge: Partial<Record<string, number>> = config.cacheMaxAgeMs,
  limitBytes = config.maxCacheBytes
): number {
  const units = cacheUnits(root);
  let total = units.reduce((sum, u) => sum + u.size, 0);
  let byAge = 0;
  let byLimit = 0;
  let freed = 0;

  const kept: CacheUnit[] = [];
  for (const unit of units) {
    const limit = maxAge[unit.group];
    const idle = now - unit.mtime;
    if (limit && idle > limit && idle >= BUSY_WINDOW_MS) {
      removeUnit(unit);
      total -= unit.size;
      freed += unit.size;
      byAge++;
    } else {
      kept.push(unit);
    }
  }

  if (total > limitBytes) {
    for (const unit of kept.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= limitBytes) break;
      if (now - unit.mtime < BUSY_WINDOW_MS) continue;
      removeUnit(unit);
      total -= unit.size;
      freed += unit.size;
      byLimit++;
    }
  }

  const uploadsRemoved = pendingUploads.items;
  freed += pendingUploads.bytes;
  pendingUploads = { items: 0, bytes: 0 };
  lastSweep = { at: now, byAge, byLimit, uploads: uploadsRemoved, freedBytes: freed };
  sweepTotals.items += byAge + byLimit + uploadsRemoved;
  sweepTotals.bytes += freed;
  statsMemo = null;
  if (byAge) console.log(`[Limpeza] ${byAge} item(ns) do cache sem uso além do prazo removidos.`);
  if (byLimit) console.log(`[Limpeza] Cache acima do limite: ${byLimit} item(ns) menos usados removidos.`);
  return byAge + byLimit;
}

export interface CacheStats {
  bytes: number;
  limitBytes: number;
  groups: Record<CacheGroup, number>;
  /** Envios de vídeo (`.uploads/`): uso, cota da pasta e quantos há. */
  uploads: { bytes: number; limitBytes: number; count: number };
  disk: { freeBytes: number; totalBytes: number } | null;
  lastSweep: SweepReport | null;
  /** Itens e bytes removidos pela limpeza desde que o servidor subiu. */
  totals: { items: number; bytes: number };
}

let statsMemo: { at: number; value: CacheStats } | null = null;

/** Tamanho do cache por tipo, disco livre e a última limpeza. Recalcula no máximo 1 vez por minuto. */
export function getCacheStats(now = Date.now()): CacheStats {
  if (statsMemo && now - statsMemo.at < 60_000) return { ...statsMemo.value, lastSweep, totals: { ...sweepTotals } };
  const groups: Record<CacheGroup, number> = { subtitles: 0, fonts: 0, hls: 0, audio: 0 };
  let bytes = 0;
  for (const unit of cacheUnits(CACHE_ROOT)) {
    bytes += unit.size;
    if ((CACHE_GROUPS as string[]).includes(unit.group)) groups[unit.group as CacheGroup] += unit.size;
  }
  let disk: CacheStats['disk'] = null;
  try {
    const st = fs.statfsSync(CACHE_ROOT);
    disk = { freeBytes: Number(st.bavail) * Number(st.bsize), totalBytes: Number(st.blocks) * Number(st.bsize) };
  } catch {
    // sem statfs nesta plataforma/volume
  }
  let uploadCount = 0;
  try {
    uploadCount = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    // ainda não existe
  }
  const uploads = { bytes: dirSize(UPLOAD_DIR), limitBytes: config.maxUploadDiskBytes, count: uploadCount };
  const value: CacheStats = { bytes, limitBytes: config.maxCacheBytes, groups, uploads, disk, lastSweep, totals: { ...sweepTotals } };
  statsMemo = { at: now, value };
  return value;
}

let timer: NodeJS.Timeout | null = null;

/** Roda uma varredura agora e depois a cada 15 min. Idempotente (o plugin do Vite pode registrar mais de uma vez). */
export function startCleanup() {
  if (timer) return;
  const run = () => {
    try {
      sweepUploads();
      sweepCache();
    } catch (err) {
      console.warn('[Limpeza] Falha na varredura:', (err as Error)?.message);
    }
  };
  setTimeout(run, 5000).unref();
  timer = setInterval(run, SWEEP_EVERY_MS);
  timer.unref();
}
