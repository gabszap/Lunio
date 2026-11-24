import { config } from './config';
import { redisKeys, waitRedisReady, withRedis } from './media/redis';
import { PLAYLIST_MAX_ITEMS, REQUESTS_MAX_ITEMS } from '../types/sync';
import type { BannedMember, ChatMessage, PlaylistItem, RoomMedia, RoomVisibility } from '../types/sync';

/**
 * Estado das salas que precisa sobreviver a um restart do servidor (deploy, queda, reinício da VPS):
 * Host, configurações (nome, visibilidade, senha, auto-pause), banidos, fila, pedidos, chat recente, vídeo e posição.
 * RAM continua sendo a autoridade do que aparece na tela; sem `REDIS_URL` nada disto existe e o comportamento é o de sempre.
 */

export interface PersistedRoom {
  v: 1;
  roomId: string;
  hostId: string;
  /** Nome personalizável da sala. */
  name?: string;
  /** Visibilidade da sala ('public' | 'private'). */
  visibility?: RoomVisibility;
  /** Hash salted scrypt da senha (nunca texto puro). */
  passwordHash?: string;
  /** Se o Host trancou novas entradas na sala. */
  locked?: boolean;
  /** Pausa automática quando alguém trava em buffering. */
  autoPauseOnBuffer?: boolean;
  /** Quando a sala foi criada (ms). JSONs antigos sem o campo fazem fallback para `savedAt`. */
  createdAt?: number;
  media: RoomMedia | null;
  playlist: PlaylistItem[];
  /** Pedidos pendentes dos espectadores. */
  requests?: PlaylistItem[];
  /** Histórico recente do chat (até 50 mensagens). */
  chatHistory?: ChatMessage[];
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
    playlist.push({
      id: i.id,
      url: i.url,
      title: i.title,
      mimeType: isString(i.mimeType, 100) ? i.mimeType : undefined,
      fingerprint: isString(i.fingerprint, 320) ? i.fingerprint : undefined,
      addedById: i.addedById,
      addedBy: i.addedBy,
    });
  }

  const requests: PlaylistItem[] = [];
  if (Array.isArray(r.requests)) {
    for (const item of r.requests.slice(0, REQUESTS_MAX_ITEMS)) {
      const i = item as Record<string, unknown>;
      if (!isString(i?.id, 128) || !isString(i.url) || !isString(i.title, 400) || !isString(i.addedById, 128) || !isString(i.addedBy, 128)) continue;
      requests.push({
        id: i.id,
        url: i.url,
        title: i.title,
        mimeType: isString(i.mimeType, 100) ? i.mimeType : undefined,
        fingerprint: isString(i.fingerprint, 320) ? i.fingerprint : undefined,
        addedById: i.addedById,
        addedBy: i.addedBy,
      });
    }
  }

  const chatHistory: ChatMessage[] = [];
  if (Array.isArray(r.chatHistory)) {
    for (const entry of r.chatHistory.slice(-50)) {
      const c = entry as Record<string, unknown>;
      if (
        !isString(c?.id, 128) ||
        !isString(c.userId, 128) ||
        !isString(c.username, 128) ||
        !isString(c.text, 1000) ||
        typeof c.timestamp !== 'number' ||
        !Number.isFinite(c.timestamp)
      ) {
        continue;
      }
      chatHistory.push({
        id: c.id,
        userId: c.userId,
        username: c.username,
        avatarUrl: isString(c.avatarUrl) ? c.avatarUrl : undefined,
        text: c.text,
        timestamp: c.timestamp,
        isSystem: c.isSystem === true ? true : undefined,
      });
    }
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
  const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) && r.createdAt > 0 ? r.createdAt : r.savedAt;
  const name = isString(r.name, 64) && r.name.trim() ? r.name.trim() : undefined;
  const visibility: RoomVisibility = r.visibility === 'private' ? 'private' : 'public';
  const passwordHash =
    isString(r.passwordHash, 256) && /^[a-f0-9]{32}:[a-f0-9]{64}$/.test(r.passwordHash) ? r.passwordHash : undefined;
  const locked = r.locked === true;
  const autoPauseOnBuffer = r.autoPauseOnBuffer === true;

  return {
    v: 1,
    roomId: r.roomId,
    hostId: r.hostId,
    name,
    visibility,
    passwordHash,
    locked,
    autoPauseOnBuffer,
    createdAt,
    media,
    playlist,
    requests,
    chatHistory,
    bans,
    playback: { playing: p.playing === true, position, rate },
    savedAt: r.savedAt,
  };
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
