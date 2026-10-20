import fs from 'node:fs';
import path from 'node:path';
import { newestMtime, UPLOAD_DIR, UPLOAD_META, writeUploadMeta } from './uploads';
import { redisKeys, REDIS_TTL_S, waitRedisReady, withRedis } from './redis';
import { config } from '../config';

/**
 * Índice do que os `.meta.json` não guardam bem: o último uso de cada envio (quente, muda a cada leitura)
 * e a hora em que a sala de cada envio fechou (persistida no `.meta.json` para sobreviver ao restart).
 * Com `REDIS_URL` o Redis leva as duas (rápido, teto de 300 ms, ttl de 48 h); sem ele, ou com ele fora,
 * tudo continua vindo do disco — que é a verdade sobre o que existe (ver ENVIOS-REDIS.md).
 */

/** Nenhuma marcação de leitura entra no índice mais rápido que isto (o mtime do arquivo também não precisa mais). */
const TOUCH_THROTTLE_MS = 60_000;
/** Chaves do índice expiram em 48 h (o Redis não tem persistência; o disco repõe na subida). */
const TTL_MS = 48 * 60 * 60 * 1000;

export interface UploadIndex {
  /** Anota o envio como usado em `at`. `true` quando um valor novo entrou (passou do teto de 1/min). */
  touch(id: string, at: number): boolean;
  /** Último uso gravado no índice — do Redis quando há, `undefined` para cair no `mtime` do disco. */
  lastRead(id: string): Promise<number | undefined>;
  /** O envio deixou de existir no disco: esqueça-o. */
  forget(id: string): void;
  /** A sala fechou: grava `closedAt` no `.meta.json` dos envios dela (sobrevive ao restart do servidor). */
  closeRoom(roomId: string, closedAt: number, dir?: string): void;
  /** A sala está de pé de novo: volta o `closedAt` dos envios dela a `null`. */
  reopenRoom(roomId: string, dir?: string): void;
  /** Na subida: repõe no Redis o que varrer o disco já sabe (sets da sala, `closedAt`, último uso). */
  rebuild(dir?: string): Promise<void>;
  /** O envio mudou de sala (reaberto numa sala nova): muda o id de set (só o Redis se importa). */
  moveRoomUpload(id: string, fromRoomId: string | undefined, toRoomId: string): void;
}

export class MemoryUploadIndex implements UploadIndex {
  private lastReadMap = new Map<string, number>();

  touch(id: string, at: number): boolean {
    const previous = this.lastReadMap.get(id) ?? 0;
    if (at - previous < TOUCH_THROTTLE_MS) return false;
    this.lastReadMap.set(id, at);
    return true;
  }

  async lastRead(id: string): Promise<number | undefined> {
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

  async rebuild(): Promise<void> {}

  moveRoomUpload(): void {}
}

/** O mesmo io de disco do `MemoryUploadIndex`, com o Redis levando as chaves quentes por cima (fire-and-forget). */
export class RedisUploadIndex implements UploadIndex {
  private lastReadMap = new Map<string, number>();

  touch(id: string, at: number): boolean {
    const previous = this.lastReadMap.get(id) ?? 0;
    if (at - previous < TOUCH_THROTTLE_MS) return false;
    this.lastReadMap.set(id, at);
    void withRedis(undefined, (r) => r.set(redisKeys.lastRead(id), String(at), 'PX', TTL_MS));
    return true;
  }

  async lastRead(id: string): Promise<number | undefined> {
    const past = await withRedis(undefined, (r) => r.get(redisKeys.lastRead(id)));
    const value = Number(past);
    return Number.isFinite(value) && value > 0 ? value : this.lastReadMap.get(id);
  }

  forget(id: string): void {
    this.lastReadMap.delete(id);
    void withRedis(undefined, (r) => r.del(redisKeys.lastRead(id)));
  }

  closeRoom(roomId: string, closedAt: number, dir = UPLOAD_DIR): void {
    const ids = patchRoomUploadsClosedAt(roomId, dir, closedAt);
    void withRedis(undefined, async (r) => {
      // Um pipeline só: um `await` por id estouraria o teto de 300 ms numa sala com muitos envios e gravaria pela metade
      const pipeline = r.pipeline();
      for (const id of ids) pipeline.sadd(redisKeys.roomUploads(roomId), id);
      if (ids.length) pipeline.expire(redisKeys.roomUploads(roomId), REDIS_TTL_S);
      pipeline.set(redisKeys.roomClosed(roomId), String(closedAt), 'PX', TTL_MS);
      await pipeline.exec();
    });
  }

  reopenRoom(roomId: string, dir = UPLOAD_DIR): void {
    patchRoomUploadsClosedAt(roomId, dir, null);
    void withRedis(undefined, (r) => r.del(redisKeys.roomClosed(roomId)));
  }

  /**
   * Varre `.uploads/` e repõe no Redis o que o disco sabe. Espera a conexão ficar pronta (sem isso o pipeline falha) e
   * grava o último uso como o mais recente dentro da pasta, e não o `mtime` da pasta (que só muda quando entra arquivo).
   */
  async rebuild(dir = UPLOAD_DIR): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const ids = entries.filter((e) => e.isDirectory() && /^[a-f0-9]{16}$/.test(e.name)).map((e) => e.name);
    if (ids.length === 0 || !(await waitRedisReady())) return;
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      await withRedis(
        undefined,
        async (r) => {
          const pipeline = r.pipeline();
          for (const id of batch) {
            try {
              const meta = JSON.parse(fs.readFileSync(path.join(dir, id, UPLOAD_META), 'utf-8'));
              if (typeof meta.roomId !== 'string') continue;
              if (typeof meta.closedAt === 'number' && meta.closedAt) {
                pipeline.set(redisKeys.roomClosed(meta.roomId), String(meta.closedAt), 'PX', TTL_MS);
                pipeline.sadd(redisKeys.roomUploads(meta.roomId), id);
              }
              pipeline.set(redisKeys.lastRead(id), String(Math.floor(newestMtime(path.join(dir, id)))), 'PX', TTL_MS);
            } catch {
              // sem metadados legíveis: o Redis só não sabe esse envio
            }
          }
          await pipeline.exec();
        },
        5000
      );
    }
  }

  moveRoomUpload(id: string, fromRoomId: string | undefined, toRoomId: string): void {
    void withRedis(undefined, async (r) => {
      const pipeline = r.pipeline();
      if (fromRoomId) pipeline.srem(redisKeys.roomUploads(fromRoomId), id);
      pipeline.sadd(redisKeys.roomUploads(toRoomId), id);
      pipeline.expire(redisKeys.roomUploads(toRoomId), REDIS_TTL_S);
      await pipeline.exec();
    });
  }
}

export const uploadIndex: UploadIndex = config.redisUrl ? new RedisUploadIndex() : new MemoryUploadIndex();

/**
 * Reescreve o `closedAt` nos metadados dos envios de uma sala. Os metadados antigos não têm o campo e continuam
 * válidos: a limpeza lê `null`/ausente como "não sei quando fechou" e se comporta como sempre.
 * Devolve os ids tocados (o Redis os usa como sets da sala).
 */
function patchRoomUploadsClosedAt(roomId: string, dir: string, closedAt: number | null): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const patched: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !/^[a-f0-9]{16}$/.test(e.name)) continue;
    const metaPath = path.join(dir, e.name, UPLOAD_META);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (meta.roomId !== roomId) continue;
      meta.closedAt = closedAt;
      writeUploadMeta(metaPath, meta);
      patched.push(e.name);
    } catch {
      // sem metadados legíveis, ou pasta sumindo no meio da varredura: a limpeza cuida depois
    }
  }
  return patched;
}
