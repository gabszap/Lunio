import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { roomManager } from './roomServer';
import { UPLOAD_DIR, UPLOAD_META } from './sources';

/**
 * Limpeza automática de disco:
 *  - `.uploads/`: apaga o envio de sala encerrada há mais de `UPLOAD_TTL_HOURS`;
 *  - `.cache/`: se passar de `MAX_CACHE_GB`, apaga o que foi usado há mais tempo (LRU).
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

interface CacheUnit {
  path: string;
  size: number;
  mtime: number;
}

/** Unidades de despejo: cada arquivo de legenda/áudio e cada pasta de fontes (que tem um marcador `.extracted`). */
function cacheUnits(): CacheUnit[] {
  const units: CacheUnit[] = [];
  let groups: fs.Dirent[];
  try {
    groups = fs.readdirSync(CACHE_ROOT, { withFileTypes: true });
  } catch {
    return units;
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const groupDir = path.join(CACHE_ROOT, g.name);
    for (const e of fs.readdirSync(groupDir, { withFileTypes: true })) {
      const full = path.join(groupDir, e.name);
      try {
        units.push({
          path: full,
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

export function sweepCache(now = Date.now()): number {
  const units = cacheUnits();
  let total = units.reduce((sum, u) => sum + u.size, 0);
  if (total <= config.maxCacheBytes) return 0;
  let removed = 0;
  for (const unit of units.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= config.maxCacheBytes) break;
    if (now - unit.mtime < BUSY_WINDOW_MS) continue;
    fs.rmSync(unit.path, { recursive: true, force: true });
    total -= unit.size;
    removed++;
  }
  if (removed) console.log(`[Limpeza] Cache acima do limite: ${removed} item(ns) menos usados removidos.`);
  return removed;
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
