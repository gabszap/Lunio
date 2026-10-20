import { config } from './config';
import { redisKeys, waitRedisReady, withRedis } from './media/redis';
import { PLAYLIST_MAX_ITEMS } from '../types/sync';
import type { BannedMember, PlaylistItem, RoomMedia } from '../types/sync';

/**
 * Estado das salas que precisa sobreviver a um restart do servidor (deploy, queda, reinício da VPS):
 * quem é o Host, os banidos, a fila, o vídeo e a posição. O que NÃO vai: quem está conectado (volta sozinho ao
 * reconectar), o chat e o `ready` de cada pessoa. RAM continua sendo a autoridade do que aparece na tela; o Redis só
 * guarda o que dá para repor depois de uma ida e volta. Sem `REDIS_URL` nada disto existe e o comportamento é o de sempre.
 */

export interface PersistedRoom {
  v: 1;
  roomId: string;
  hostId: string;
  media: RoomMedia | null;
  playlist: PlaylistItem[];
  bans: BannedMember[];
  playback: { playing: boolean; position: number; rate: number };
  /** Quando foi gravado: o relógio decide se ainda vale (o TTL do Redis é só a rede de proteção). */
  savedAt: number;
}

export interface RoomStore {
  /** Grava (substitui) o estado da sala. Nunca rejeita: falha vira aviso e a sala segue só em memória. */
  save(room: PersistedRoom): Promise<void>;
  /** A sala encerrou: some do Redis (sala fechada não guarda nem a fila). */
  remove(roomId: string): Promise<void>;
  /** Na subida: as salas gravadas e as que já estavam encerradas (para a Home dizer "encerrada"). */
  loadAll(): Promise<{ rooms: PersistedRoom[]; closed: Array<{ roomId: string; at: number }> }>;
}

/** Sem Redis: nada é gravado e nada volta. */
export class NullRoomStore implements RoomStore {
  async save(): Promise<void> {}
  async remove(): Promise<void> {}
  async loadAll() {
    return { rooms: [], closed: [] };
  }
}

const ROOM_ID = /^[\w-]{1,64}$/;
const isString = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max;

/** Confere o que veio do Redis: um valor estranho (versão antiga, lixo) é descartado, nunca derruba a subida. */
export function parsePersistedRoom(raw: unknown): PersistedRoom | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !isString(r.roomId, 64) || !ROOM_ID.test(r.roomId) || !isString(r.hostId, 128)) return null;
  if (typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) return null;
  if (!Array.isArray(r.playlist) || r.playlist.length > PLAYLIST_MAX_ITEMS) return null;
  if (!Array.isArray(r.bans) || r.bans.length > 500) return null;

  const playlist: PlaylistItem[] = [];
  for (const item of r.playlist) {
    const i = item as Record<string, unknown>;
    if (!isString(i?.id, 128) || !isString(i.url) || !isString(i.title, 400) || !isString(i.addedById, 128) || !isString(i.addedBy, 128)) return null;
    playlist.push({ id: i.id, url: i.url, title: i.title, mimeType: isString(i.mimeType, 100) ? i.mimeType : undefined, addedById: i.addedById, addedBy: i.addedBy });
  }

  const bans: BannedMember[] = [];
  for (const ban of r.bans) {
    const b = ban as Record<string, unknown>;
    if (!isString(b?.userId, 128) || !isString(b.username, 128) || typeof b.bannedAt !== 'number') return null;
    bans.push({
      userId: b.userId,
      username: b.username,
      avatarUrl: isString(b.avatarUrl) ? b.avatarUrl : undefined,
      platform: b.platform === 'discord' || b.platform === 'web' ? b.platform : undefined,
      bannedAt: b.bannedAt,
    });
  }

  let media: RoomMedia | null = null;
  if (r.media !== null && r.media !== undefined) {
    const m = r.media as Record<string, unknown>;
    if (!isString(m?.url) || !isString(m.title, 400) || typeof m.generation !== 'number' || typeof m.duration !== 'number') return null;
    media = r.media as RoomMedia;
  }

  const p = (r.playback ?? {}) as Record<string, unknown>;
  const rate = typeof p.rate === 'number' && p.rate > 0 && p.rate <= 4 ? p.rate : 1;
  const position = typeof p.position === 'number' && p.position >= 0 && Number.isFinite(p.position) ? p.position : 0;

  return { v: 1, roomId: r.roomId, hostId: r.hostId, media, playlist, bans, playback: { playing: p.playing === true, position, rate }, savedAt: r.savedAt };
}

/** O Redis como armazém: um JSON por sala (leitura e escrita atômicas, sem corrida entre teclas) com validade. */
export class RedisRoomStore implements RoomStore {
  async save(room: PersistedRoom): Promise<void> {
    await withRedis(undefined, (r) => r.set(redisKeys.roomState(room.roomId), JSON.stringify(room), 'PX', config.roomStateTtlMs).then(() => undefined));
  }

  async remove(roomId: string): Promise<void> {
    await withRedis(undefined, (r) => r.del(redisKeys.roomState(roomId)).then(() => undefined));
  }

  async loadAll() {
    const empty = { rooms: [] as PersistedRoom[], closed: [] as Array<{ roomId: string; at: number }> };
    // A subida espera o Redis ficar pronto (no máximo 2 s) e a leitura inteira ter 3 s: Redis fora não segura o servidor
    if (!(await waitRedisReady(2000))) return empty;
    return withRedis(
      empty,
      async (r) => {
        const rooms: PersistedRoom[] = [];
        const closed: Array<{ roomId: string; at: number }> = [];

        // SCAN, nunca KEYS: não trava o Redis mesmo com muitas chaves
        const scan = async (pattern: string): Promise<string[]> => {
          const keys: string[] = [];
          let cursor = '0';
          do {
            const [next, batch] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
            cursor = next;
            keys.push(...batch);
          } while (cursor !== '0');
          return keys;
        };

        const stateKeys = await scan(redisKeys.roomState('*'));
        for (let i = 0; i < stateKeys.length; i += 100) {
          const values = await r.mget(...stateKeys.slice(i, i + 100));
          for (const value of values) {
            if (!value) continue;
            try {
              const room = parsePersistedRoom(JSON.parse(value));
              if (room) rooms.push(room);
            } catch {
              // JSON quebrado: descarta
            }
          }
        }

        const closedKeys = await scan(redisKeys.roomClosed('*'));
        if (closedKeys.length) {
          const prefix = redisKeys.roomClosed('');
          const values = await r.mget(...closedKeys.slice(0, 500));
          closedKeys.slice(0, 500).forEach((key, idx) => {
            const at = Number(values[idx]);
            const roomId = key.slice(prefix.length);
            if (ROOM_ID.test(roomId) && Number.isFinite(at) && at > 0) closed.push({ roomId, at });
          });
        }
        return { rooms, closed };
      },
      3000
    );
  }
}

export const roomStore: RoomStore = config.redisUrl ? new RedisRoomStore() : new NullRoomStore();
