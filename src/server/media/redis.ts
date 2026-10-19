import Redis from 'ioredis';
import { config } from '../config';

/**
 * Conexão com o Redis, opcional e sempre descartável: nenhuma chamada passa de `CEILING_MS`
 * e nenhuma falha sobe (cai no disco, que é a verdade sobre os envios — ver ENVIOS-REDIS.md).
 * Sem `REDIS_URL` não há cliente nenhum e o sistema funciona só com o disco.
 */

/** Teto de cada consulta ao Redis: mais lento que isso vale indisponível. */
const CEILING_MS = 300;
/** Aviso de falha no log: no máximo 1 vez por minuto, para não encher o log quando cai. */
const WARN_EVERY_MS = 60_000;

const PREFIX = 'lunio:';
export const redisKeys = {
  lastRead: (id: string) => `${PREFIX}up:${id}:read`,
  roomUploads: (roomId: string) => `${PREFIX}up:room:${roomId}`,
  roomClosed: (roomId: string) => `${PREFIX}room:closed:${roomId}`,
};

const TTL_MS = 48 * 60 * 60 * 1000;

let client: Redis | null = null;

function getClient(): Redis | null {
  if (!config.redisUrl) return null;
  if (!client) {
    client = new Redis(config.redisUrl, {
      lazyConnect: true, // o servidor sobe mesmo sem Redis; conecta na 1ª chamada
      maxRetriesPerRequest: 0, // sem fila infinita: quem chama já tem teto próprio
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 300, 1000)),
      enableOfflineQueue: false,
      commandTimeout: CEILING_MS,
    });
  }
  return client;
}

let lastWarn = 0;

/** Roda `fn` contra o Redis com teto de tempo; qualquer falha devolve `fallback` (e avisa, 1×/min). */
export async function withRedis<T>(fallback: T, fn: (redis: Redis) => Promise<T>): Promise<T> {
  const redis = getClient();
  if (!redis) return fallback;
  try {
    return await Promise.race([fn(redis), timeout0(CEILING_MS, fallback)]);
  } catch (err) {
    if (Date.now() - lastWarn > WARN_EVERY_MS) {
      lastWarn = Date.now();
      console.warn(`[Redis] Indisponível (${(err as Error)?.message ?? 'sem resposta'}); seguindo só com o disco.`);
    }
    return fallback;
  }
}

function timeout0<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export interface RedisStatus {
  /** Há `REDIS_URL` configurado? Sem ele o sistema vive só do disco. */
  enabled: boolean;
  /** Conexão em pé agora (após a 1ª chamada; antes dela é `false` também com `enabled`). */
  connected: boolean;
}

export function getRedisStatus(): RedisStatus {
  const c = getClient();
  return { enabled: c !== null, connected: c !== null && c.status === 'ready' };
}

/** TTL em segundos das chaves do índice (o Redis conta TTL em segundos, não ms). */
export const REDIS_TTL_S = Math.floor(TTL_MS / 1000);
