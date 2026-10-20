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
  // Prefixo próprio (não `room:<id>:state`): com ids livres, `room:closed:<id>` e `room:<id>:state` podiam se confundir
  roomState: (roomId: string) => `${PREFIX}roomstate:${roomId}`,
};

const TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Reconecta para sempre, com espera crescente (0,5 s até 5 s). Antes desistia depois de 3 tentativas (~2 s): um
 * `docker restart` do Redis deixava o Lunio no disco até reiniciar o Node. Sem fila offline, cada comando durante a
 * queda falha na hora e cai no disco; reconectar não custa nada.
 */
export const redisRetryStrategy = (times: number): number => Math.min(times * 500, 5000);

let client: Redis | null = null;

function getClient(): Redis | null {
  if (!config.redisUrl) return null;
  if (!client) {
    client = new Redis(config.redisUrl, {
      lazyConnect: true, // o servidor sobe mesmo sem Redis; conecta no arranque (abaixo)
      maxRetriesPerRequest: 0, // sem fila infinita: quem chama já tem teto próprio
      retryStrategy: redisRetryStrategy,
      enableOfflineQueue: false,
      commandTimeout: CEILING_MS,
    });
    client.on('error', (err) => {
      // sem ouvinte o ioredis imprime "Unhandled error event"; com ele, avisamos no teto do lastWarn
      if (Date.now() - lastWarn > WARN_EVERY_MS) {
        lastWarn = Date.now();
        console.warn(`[Redis] Falha de conexão (${err.message}); seguindo só com o disco.`);
      }
    });
    // Conecta no arranque: o Status exibe o estado real sem depender de haver tráfego de envios
    void client.connect().catch(() => undefined); // a falha vira o aviso do 'error' acima
  }
  return client;
}

let lastWarn = 0;

/** Desliga a conexão (fim dos testes, encerramento do servidor). A próxima chamada cria um cliente novo. */
export function closeRedis(): void {
  client?.disconnect();
  client = null;
}

/**
 * Roda `fn` contra o Redis com teto de tempo; qualquer falha devolve `fallback` (e avisa, 1×/min).
 * `ceilingMs` só sobe para trabalhos que sabidamente levam mais (o `rebuild` da subida).
 */
export async function withRedis<T>(fallback: T, fn: (redis: Redis) => Promise<T>, ceilingMs = CEILING_MS): Promise<T> {
  const redis = getClient();
  if (!redis) return fallback;
  try {
    return await Promise.race([fn(redis), timeout0(ceilingMs, fallback)]);
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

/**
 * Espera a conexão ficar pronta (até `ms`). Logo depois de `connect()` o cliente ainda está "connecting" e, sem fila
 * offline, qualquer comando falha com "Stream isn't writeable": foi o que deixava o `rebuild` da subida sem efeito.
 */
export async function waitRedisReady(ms = 3000): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  if (c.status === 'ready') return true;
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      c.off('ready', onReady);
      resolve(ok);
    };
    const onReady = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    c.once('ready', onReady);
  });
}

export interface RedisStatus {
  /** Há `REDIS_URL` configurado? Sem ele o sistema vive só do disco. */
  enabled: boolean;
  /** Conexão em pé agora (após a 1ª chamada; antes dela é `false` também com `enabled`). */
  connected: boolean;
}

export async function getRedisStatus(): Promise<RedisStatus> {
  const c = getClient();
  return { enabled: c !== null, connected: c !== null && c.status === 'ready' };
}

/** TTL em segundos das chaves do índice (o Redis conta TTL em segundos, não ms). */
export const REDIS_TTL_S = Math.floor(TTL_MS / 1000);
