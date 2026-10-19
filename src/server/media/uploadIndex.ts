import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR, UPLOAD_META, writeUploadMeta } from './uploads';

/**
 * Índice do que os `.meta.json` não guardam bem: o último uso de cada envio (quente, muda a cada leitura)
 * e a hora em que a sala de cada envio fechou (persistida no `.meta.json` para sobreviver ao restart).
 * Amanhã o Redis entra atrás desta interface (`REDIS_URL` dá uma segunda implementação; a de memória é a reserva).
 */

/** Nenhuma marcação de leitura entra no índice mais rápido que isto (o mtime do arquivo também não precisa mais). */
const TOUCH_THROTTLE_MS = 60_000;

export interface UploadIndex {
  /** Anota o envio como usado em `at`. `true` quando um valor novo entrou (passou do teto de 1/min). */
  touch(id: string, at: number): boolean;
  /** Último uso gravado no índice, se houver. */
  lastRead(id: string): number | undefined;
  /** O envio deixou de existir no disco: esqueça-o. */
  forget(id: string): void;
  /** A sala fechou: grava `closedAt` no `.meta.json` dos envios dela (sobrevive ao restart do servidor). */
  closeRoom(roomId: string, closedAt: number, dir?: string): void;
  /** A sala está de pé de novo: volta o `closedAt` dos envios dela a `null`. */
  reopenRoom(roomId: string, dir?: string): void;
}

export class MemoryUploadIndex implements UploadIndex {
  private lastReadMap = new Map<string, number>();

  touch(id: string, at: number): boolean {
    const previous = this.lastReadMap.get(id) ?? 0;
    if (at - previous < TOUCH_THROTTLE_MS) return false;
    this.lastReadMap.set(id, at);
    return true;
  }

  lastRead(id: string): number | undefined {
    return this.lastReadMap.get(id);
  }

  forget(id: string): void {
    this.lastReadMap.delete(id);
  }

  closeRoom(roomId: string, closedAt: number, dir = UPLOAD_DIR): void {
    patchRoomUploadsClosedAt(roomId, dir, closedAt);
  }

  reopenRoom(roomId: string, dir = UPLOAD_DIR): void {
    patchRoomUploadsClosedAt(roomId, dir, null);
  }
}

export const uploadIndex = new MemoryUploadIndex();

/**
 * Reescreve o `closedAt` nos metadados dos envios de uma sala. Os metadados antigos não têm o campo e continuam
 * válidos: a limpeza lê `null`/ausente como "não sei quando fechou" e se comporta como sempre.
 */
function patchRoomUploadsClosedAt(roomId: string, dir: string, closedAt: number | null) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !/^[a-f0-9]{16}$/.test(e.name)) continue;
    const metaPath = path.join(dir, e.name, UPLOAD_META);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (meta.roomId !== roomId) continue;
      meta.closedAt = closedAt;
      writeUploadMeta(metaPath, meta);
    } catch {
      // sem metadados legíveis, ou pasta sumindo no meio da varredura: a limpeza cuida depois
    }
  }
}
