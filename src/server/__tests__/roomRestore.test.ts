import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RoomManager } from '../roomServer';
import { parsePersistedRoom, type PersistedRoom, type RoomStore } from '../roomStore';
import { config } from '../config';

vi.mock('../media/resolver', () => ({ warmUpMedia: vi.fn() }));

/** Armazém em memória: dois RoomManager compartilhando um simulam o restart do servidor. */
class MemoryStore implements RoomStore {
  rooms = new Map<string, PersistedRoom>();
  closed: Array<{ roomId: string; at: number }> = [];
  async save(room: PersistedRoom) {
    this.rooms.set(room.roomId, JSON.parse(JSON.stringify(room)));
  }
  async remove(roomId: string) {
    this.rooms.delete(roomId);
  }
  async loadAll() {
    return { rooms: Array.from(this.rooms.values()), closed: this.closed };
  }
}

class FakeSocket {
  readyState = 1;
  sent: any[] = [];
  closeCode: number | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closeCode = code ?? 1000;
    this.readyState = 3;
  }
  last(type: string) {
    return this.sent.filter((m) => m.type === type).at(-1);
  }
}
const asWs = (s: FakeSocket) => s as unknown as WebSocket;

let store: MemoryStore;
let rm: RoomManager;
const connect = (m: RoomManager, roomId: string, id: string) => {
  const s = new FakeSocket();
  m.handleClientMessage(asWs(s), JSON.stringify({ type: 'room:join', roomId, user: { id, username: id } }));
  return s;
};
const send = (m: RoomManager, s: FakeSocket, msg: object) => m.handleClientMessage(asWs(s), JSON.stringify(msg));
const stateOf = (m: RoomManager, roomId: string) => m.getRoomState(m.getOrCreateRoom(roomId));

/** Monta uma sala com Host, convidados, fila, ban e mídia, grava e "reinicia" o servidor. */
async function restartWithRoom() {
  const host = connect(rm, 'SALA', 'host');
  const bad = connect(rm, 'SALA', 'bad');
  send(rm, host, { type: 'playlist:add', url: 'https://exemplo.test/ep1.mkv', title: 'Ep 1' });
  send(rm, host, { type: 'media:set', media: { url: 'https://exemplo.test/a.mkv', title: 'Filme', duration: 100 }, initialPosition: 0 });
  send(rm, host, { type: 'room:ban', targetUserId: 'bad' });
  expect(bad.closeCode).not.toBeNull();
  await rm.flushPersistence();
  rm = new RoomManager(store); // processo novo, sem nada em memória
  await rm.restore();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  store = new MemoryStore();
  rm = new RoomManager(store);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('restauração das salas depois de um restart', () => {
  it('Host, mídia, fila e banidos voltam', async () => {
    await restartWithRoom();
    const state = stateOf(rm, 'SALA');
    expect(state.hostId).toBe('host');
    expect(state.media).toMatchObject({ title: 'Filme', generation: 1 });
    expect(state.playlist!.map((i) => i.title)).toEqual(['Ep 1']);
    expect(state.bannedMembers!.map((b) => b.userId)).toEqual(['bad']);
    expect(rm.getRoomInfo('SALA')).toMatchObject({ exists: true, closed: false });
  });

  it('o banido continua barrado', async () => {
    await restartWithRoom();
    const bad = connect(rm, 'SALA', 'bad');
    expect(bad.last('error')).toMatchObject({ code: 'banned' });
  });

  it('quem reconecta primeiro NÃO vira Host nos 60 s; o Host antigo retoma', async () => {
    await restartWithRoom();
    const guest = connect(rm, 'SALA', 'guest');
    expect(stateOf(rm, 'SALA').hostId).toBe('host');
    expect(guest.last('room:state')?.hostId ?? 'host').toBe('host');

    const host = connect(rm, 'SALA', 'host');
    expect(stateOf(rm, 'SALA').hostId).toBe('host');
    send(rm, host, { type: 'playback:pause', position: 5 });
    expect(stateOf(rm, 'SALA').playback.position).toBe(5);
    // Voltou: o prazo não elege mais ninguém
    vi.advanceTimersByTime(config.hostGraceMs + 1000);
    expect(stateOf(rm, 'SALA').hostId).toBe('host');
  });

  it('se o Host não volta, passada a janela o primeiro conectado assume', async () => {
    await restartWithRoom();
    connect(rm, 'SALA', 'guest');
    vi.advanceTimersByTime(config.hostGraceMs + 100);
    expect(stateOf(rm, 'SALA').hostId).toBe('guest');
  });

  it('sala restaurada que ninguém ocupa encerra e some do armazém', async () => {
    await restartWithRoom();
    vi.advanceTimersByTime(config.hostGraceMs + 30_000 + 100);
    expect(rm.getRoomInfo('SALA').closed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.rooms.has('SALA')).toBe(false);
  });

  it('salas já encerradas voltam como encerradas', async () => {
    store.closed.push({ roomId: 'VELHA', at: Date.now() - 1000 });
    await rm.restore();
    expect(rm.getRoomInfo('VELHA')).toMatchObject({ exists: false, closed: true });
  });

  it('estado mais velho que o TTL é ignorado', async () => {
    await store.save({ v: 1, roomId: 'ANTIGA', hostId: 'h', media: null, playlist: [], bans: [], playback: { playing: false, position: 0, rate: 1 }, savedAt: Date.now() - config.roomStateTtlMs - 1000 });
    await rm.restore();
    expect(rm.getRoomInfo('ANTIGA').exists).toBe(false);
  });

  it('reproduzindo e parado há pouco: segue tocando com a posição avançada; parado há muito: volta pausado', async () => {
    const base = { v: 1 as const, hostId: 'h', media: null, playlist: [], bans: [] };
    await store.save({ ...base, roomId: 'CURTA', playback: { playing: true, position: 10, rate: 1 }, savedAt: Date.now() - 20_000 });
    await store.save({ ...base, roomId: 'LONGA', playback: { playing: true, position: 10, rate: 1 }, savedAt: Date.now() - 600_000 });
    await rm.restore();
    const curta = stateOf(rm, 'CURTA').playback;
    expect(curta.playing).toBe(true);
    expect(curta.position).toBeGreaterThanOrEqual(30);
    const longa = stateOf(rm, 'LONGA').playback;
    expect(longa.playing).toBe(false);
    expect(longa.position).toBe(10);
  });
});

describe('gravação', () => {
  it('mudanças de estado são gravadas com debounce, e sala que fecha é removida', async () => {
    const host = connect(rm, 'GRAVA', 'host');
    send(rm, host, { type: 'playlist:add', url: 'https://exemplo.test/x.mkv', title: 'X' });
    expect(store.rooms.has('GRAVA')).toBe(false); // ainda no debounce
    await vi.advanceTimersByTimeAsync(300);
    expect(store.rooms.get('GRAVA')?.playlist).toHaveLength(1);

    rm.handleLeave(asWs(host));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.rooms.has('GRAVA')).toBe(false);
  });
});

describe('parsePersistedRoom', () => {
  const ok = { v: 1, roomId: 'ABC', hostId: 'h', media: null, playlist: [], bans: [], playback: { playing: false, position: 3, rate: 1 }, savedAt: 1 };

  it('aceita um estado válido', () => {
    expect(parsePersistedRoom(ok)).toMatchObject({ roomId: 'ABC', playback: { position: 3 } });
  });

  it('descarta lixo, versão antiga e ids inválidos', () => {
    expect(parsePersistedRoom(null)).toBeNull();
    expect(parsePersistedRoom('x')).toBeNull();
    expect(parsePersistedRoom({ ...ok, v: 0 })).toBeNull();
    expect(parsePersistedRoom({ ...ok, roomId: '../x' })).toBeNull();
    expect(parsePersistedRoom({ ...ok, playlist: [{ id: 1 }] })).toBeNull();
    expect(parsePersistedRoom({ ...ok, savedAt: 'ontem' })).toBeNull();
  });

  it('corrige taxa e posição absurdas', () => {
    const p = parsePersistedRoom({ ...ok, playback: { playing: true, position: -5, rate: 99 } })!;
    expect(p.playback).toEqual({ playing: true, position: 0, rate: 1 });
  });
});
