import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

export const UPLOAD_DIR = path.resolve(config.rootDir, '.uploads');
export const UPLOAD_META = '.meta.json';

export const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
};

/** Envios que ainda estão chegando: nunca são apagados pela regra de "um envio por sala". */
export const uploadsInProgress = new Set<string>();

/** O id (16 hex) de um link de envio, ou `null` se a URL não é de um envio deste servidor. */
export function uploadIdFromUrl(url: string): string | null {
  return /\/api\/uploads\/([a-f0-9]{16})\//.exec(url)?.[1] ?? null;
}

/**
 * Uma sala, um envio: apaga os envios da sala que não estão em uso (`keepIds` = mídia atual e fila da sala, mais o que
 * acabou de chegar). Sem isso cada envio novo ficava no disco até a sala fechar e a cota (20 GB) enchia sozinha.
 */
export function pruneRoomUploads(roomId: string, keepIds: Set<string>, dir = UPLOAD_DIR): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !/^[a-f0-9]{16}$/.test(e.name)) continue;
    if (keepIds.has(e.name) || uploadsInProgress.has(e.name)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, e.name, UPLOAD_META), 'utf-8'));
      if (meta.roomId !== roomId) continue;
      fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
      removed++;
      console.log(`[Upload] Envio ${e.name} removido (a sala ${roomId} já tem outro).`);
    } catch {
      // sem metadados legíveis, ou em uso no Windows: a varredura do cleanup cuida depois
    }
  }
  return removed;
}

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
