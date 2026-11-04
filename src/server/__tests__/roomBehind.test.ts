import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RoomManager } from '../roomServer';
import type { PersistedRoom, RoomStore } from '../roomStore';

vi.mock('../media/resolver', () => ({ warmUpMedia: vi.fn() }));

class MemoryStore implements RoomStore {
  rooms = new Map<string, PersistedRoom>();
  async save(room: PersistedRoom) {
    this.rooms.set(room.roomId, JSON.parse(JSON.stringify(room)));
  }
  async remove(roomId: string) {
    this.rooms.delete(roomId);
  }
  async loadAll() {
    return { rooms: Array.from(this.rooms.values()), closed: [] };
  }
}

class FakeSocket {
  readyState = 1;
  sent: any[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  of(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
  clear() {
    this.sent = [];
  }
}
const asWs = (s: FakeSocket) => s as unknown as WebSocket;

let rm: RoomManager;
const connect = (roomId: string, id: string) => {
  const s = new FakeSocket();
  rm.handleClientMessage(asWs(s), JSON.stringify({ type: 'room:join', roomId, user: { id, username: id } }));
  return s;
};
const send = (s: FakeSocket, msg: object) => rm.handleClientMessage(asWs(s), JSON.stringify(msg));
const heartbeat = (s: FakeSocket, currentTime: number, extra: object = {}) =>
  send(s, { type: 'client:heartbeat', clientTime: Date.now(), currentTime, state: 'ready', ...extra });
/** Os membros da última lista que o Host recebeu. */
const members = (host: FakeSocket) => host.of('members:update').at(-1)?.members as Array<{ id: string; behindMs?: number }> | undefined;
const behindOf = (host: FakeSocket, id: string) => members(host)?.find((m) => m.id === id)?.behindMs;

/** Sala tocando desde a posição 100 s, com o Host e um espectador pronto. */
function playing() {
  const host = connect('ATRASO', 'host');
  const guest = connect('ATRASO', 'guest');
  send(host, { type: 'media:set', media: { url: 'https://cdn.test/v.mp4', title: 'V', mimeType: 'video/mp4', chapters: [], subtitles: [], audioTracks: [] } });
  send(host, { type: 'playback:play', position: 100 });
  send(guest, { type: 'client:readiness', ready: true, state: 'playing', currentTime: 100 });
  host.clear();
  guest.clear();
  return { host, guest };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  rm = new RoomManager(new MemoryStore());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('quanto cada pessoa está atrás do Host', () => {
  it('o servidor mede pela posição informada e avisa a sala', () => {
    const { host, guest } = playing();
    vi.advanceTimersByTime(30_000); // o Host está em 130 s
    heartbeat(guest, 40, { rtt: 0 }); // o espectador diz 40 s: 90 s atrás
    expect(behindOf(host, 'guest')).toBe(90_000);
    expect(behindOf(guest, 'guest')).toBe(90_000);
  });

  it('desconta o atraso de rede da posição informada', () => {
    const { host, guest } = playing();
    vi.advanceTimersByTime(30_000);
    heartbeat(guest, 129, { rtt: 600 }); // 0,3 s de ida: já está em 129,3 s, então 700 ms atrás
    expect(behindOf(host, 'guest')).toBe(700);
  });

  it('acompanha o rtt medido pelo cliente no ping, mesmo com o relógio dele diferente', () => {
    const { host, guest } = playing();
    heartbeat(guest, 100, { clientTime: Date.now() - 90_000, rtt: 80 }); // relógio 90 s atrasado: o `now - clientTime` daria 90000
    send(host, { type: 'client:readiness', ready: true, state: 'playing', currentTime: 100 });
    const ping = (rm as any).rooms.get('ATRASO').clients.get(asWs(guest)).lastPing;
    expect(ping).toBe(40);
  });

  it('não aponta ninguém com a sala pausada, nem o Host, nem quem ainda carrega', () => {
    const { host, guest } = playing();
    vi.advanceTimersByTime(30_000);
    send(guest, { type: 'client:readiness', ready: false, state: 'loading', currentTime: 0 });
    heartbeat(guest, 0, { rtt: 0 });
    expect(behindOf(host, 'guest')).toBeUndefined();
    expect(behindOf(host, 'host')).toBeUndefined();
    send(guest, { type: 'client:readiness', ready: true, state: 'playing', currentTime: 100 });
    heartbeat(guest, 40, { rtt: 0 });
    expect(behindOf(host, 'guest')).toBe(90_000);
    send(host, { type: 'playback:pause', position: 130 });
    vi.advanceTimersByTime(5_000);
    heartbeat(guest, 40, { rtt: 0 }); // sala pausada: deixa de apontar
    expect(behindOf(host, 'guest')).toBeUndefined();
  });

  it('só reenvia a lista quando a diferença muda 1 s ou mais, e no máximo a cada 2 s', () => {
    const { host, guest } = playing();
    vi.advanceTimersByTime(30_000);
    heartbeat(guest, 40, { rtt: 0 });
    const first = host.of('members:update').length;
    expect(first).toBeGreaterThan(0);
    host.clear();
    vi.advanceTimersByTime(5_000);
    heartbeat(guest, 45.2, { rtt: 0 }); // continua 90 s atrás (variação de 0,2 s)
    expect(host.of('members:update')).toHaveLength(0);
    vi.advanceTimersByTime(5_000);
    heartbeat(guest, 52, { rtt: 0 }); // piorou: 3 s a mais de atraso
    expect(host.of('members:update').length).toBeGreaterThan(0);
  });
});
