import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { roomManager } from './roomServer';
import { UPLOAD_DIR, UPLOAD_META } from './media/uploads';

/**
 * Limpeza automática de disco:
 *  - `.uploads/`: apaga o envio de sala encerrada há mais de `UPLOAD_TTL_HOURS`;
 *  - `.cache/`: apaga o que ficou sem uso além do prazo de cada tipo (legendas 14 dias, fontes 3 dias, HLS 6 h) e,
 *    se ainda passar de `MAX_CACHE_GB`, o que foi usado há mais tempo (LRU).
 */

const CACHE_ROOT = path.resolve(process.cwd(), '.cache');
const SWEEP_EVERY_MS = 15 * 60 * 1000;
/** Arquivos mexidos há menos que isso podem estar sendo gravados agora: não apaga. */
const BUSY_WINDOW_MS = 2 * 60 * 1000;
const startedAt = Date.now();

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

export function sweepUploads(now = Date.now()): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(UPLOAD_DIR, e.name);
    let roomId: string | undefined;
    let createdAt = 0;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, UPLOAD_META), 'utf-8'));
      roomId = typeof meta.roomId === 'string' ? meta.roomId : undefined;
      createdAt = Number(meta.createdAt) || 0;
    } catch {
      // envio antigo, sem metadados
    }
    if (roomId && roomManager.isRoomActive(roomId)) continue;
    // Sala encerrada: conta a partir de quando fechou. Se o servidor reiniciou e não sabe,
    // conta a partir do início do processo (nunca apaga antes de dar o prazo inteiro).
    const closedAt = (roomId && roomManager.getClosedAt(roomId)) || Math.max(startedAt, createdAt);
    const lastUse = Math.max(closedAt, newestMtime(dir) > now - BUSY_WINDOW_MS ? now : 0);
    if (now - lastUse < config.uploadTtlMs) continue;
    fs.rmSync(dir, { recursive: true, force: true });
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

  lastSweep = { at: now, byAge, byLimit, freedBytes: freed };
  statsMemo = null;
  if (byAge) console.log(`[Limpeza] ${byAge} item(ns) do cache sem uso além do prazo removidos.`);
  if (byLimit) console.log(`[Limpeza] Cache acima do limite: ${byLimit} item(ns) menos usados removidos.`);
  return byAge + byLimit;
}

export interface CacheStats {
  bytes: number;
  limitBytes: number;
  groups: Record<CacheGroup, number>;
  disk: { freeBytes: number; totalBytes: number } | null;
  lastSweep: SweepReport | null;
}

let statsMemo: { at: number; value: CacheStats } | null = null;

/** Tamanho do cache por tipo, disco livre e a última limpeza. Recalcula no máximo 1 vez por minuto. */
export function getCacheStats(now = Date.now()): CacheStats {
  if (statsMemo && now - statsMemo.at < 60_000) return { ...statsMemo.value, lastSweep };
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
  const value: CacheStats = { bytes, limitBytes: config.maxCacheBytes, groups, disk, lastSweep };
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
