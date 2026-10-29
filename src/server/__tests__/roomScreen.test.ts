import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RoomManager } from '../roomServer';
import type { PersistedRoom, RoomStore } from '../roomStore';
import { config } from '../config';

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
  last(type: string) {
    return this.of(type).at(-1);
  }
  clear() {
    this.sent = [];
  }
}
const asWs = (s: FakeSocket) => s as unknown as WebSocket;

let rm: RoomManager;
let store: MemoryStore;
const original = { ...config.screenShare };

const connect = (roomId: string, id: string) => {
  const s = new FakeSocket();
  rm.handleClientMessage(asWs(s), JSON.stringify({ type: 'room:join', roomId, user: { id, username: id } }));
  return s;
};
const send = (s: FakeSocket, msg: object) => rm.handleClientMessage(asWs(s), JSON.stringify(msg));

/** Sala com Host e `guests` espectadores; as mensagens da entrada já foram descartadas. */
function room(guests: number, roomId = 'TELA') {
  const host = connect(roomId, 'host');
  const viewers = Array.from({ length: guests }, (_, i) => connect(roomId, `g${i + 1}`));
  for (const s of [host, ...viewers]) s.clear();
  return { host, viewers, all: [host, ...viewers] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  Object.assign(config.screenShare, { enabled: true, relayUrl: 'https://relay.test', publishToken: 'P', subscribeToken: 'S', maxLive: 2 });
  store = new MemoryStore();
  rm = new RoomManager(store);
});
afterEach(() => {
  Object.assign(config.screenShare, original);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('transmissão de tela: iniciar, ao vivo, parar', () => {
  it('o Host inicia: todos recebem o estado e o room:state seguinte o traz', () => {
    const { host, viewers, all } = room(2);
    send(host, { type: 'screen:start', quality: '720p60' });
    for (const s of all) {
      expect(s.last('screen:state').screen).toMatchObject({ quality: '720p60', live: false, hostId: 'host' });
    }
    expect(viewers[0].last('screen:state').screen.path).toMatch(/^lunio\/TELA\/[0-9a-f]{32}$/);
    expect(rm.getRoomState(rm.getOrCreateRoom('TELA')).screen).toMatchObject({ quality: '720p60' });
  });

  it('não mexe no vídeo da sala', () => {
    const { host } = room(1);
    send(host, { type: 'media:set', media: { url: 'https://exemplo.test/a.mkv', title: 'Ep', duration: 100 } });
    const before = JSON.stringify(rm.getRoomState(rm.getOrCreateRoom('TELA')).media);
    send(host, { type: 'screen:start', quality: '1080p60' });
    const state = rm.getRoomState(rm.getOrCreateRoom('TELA'));
    expect(JSON.stringify(state.media)).toBe(before);
    expect(state.media).not.toBeNull();
  });

  it('segundo screen:start com a transmissão ativa dá screen_active e mantém o caminho', () => {
    const { host } = room(1);
    send(host, { type: 'screen:start', quality: '720p30' });
    const path = rm.getScreen('TELA')!.path;
    host.clear();
    send(host, { type: 'screen:start', quality: '1080p60' });
    expect(host.last('error').code).toBe('screen_active');
    expect(rm.getScreen('TELA')!.path).toBe(path);
  });

  it('qualidade fora da tabela ou ausente dá screen_bad_quality e não cria nada', () => {
    const { host } = room(0);
    send(host, { type: 'screen:start', quality: '1440p60' });
    expect(host.last('error').code).toBe('screen_bad_quality');
    host.clear();
    send(host, { type: 'screen:start' });
    expect(host.last('error').code).toBe('screen_bad_quality');
    expect(rm.getScreen('TELA')).toBeNull();
  });

  it('com a flag desligada dá screen_disabled', () => {
    config.screenShare.enabled = false;
    const { host } = room(0);
    send(host, { type: 'screen:start', quality: '720p30' });
    expect(host.last('error').code).toBe('screen_disabled');
    expect(rm.getScreen('TELA')).toBeNull();
  });

  it('respeita o limite de transmissões simultâneas (screen_busy)', () => {
    for (const id of ['A', 'B']) send(room(0, id).host, { type: 'screen:start', quality: '720p30' });
    const third = room(0, 'C').host;
    send(third, { type: 'screen:start', quality: '720p30' });
    expect(third.last('error').code).toBe('screen_busy');
    expect(rm.getScreen('C')).toBeNull();
  });

  it('screen:live marca ao vivo e entra na contagem; sem transmissão não faz nada', () => {
    const { host, viewers } = room(1);
    send(host, { type: 'screen:live' });
    expect(rm.getScreen('TELA')).toBeNull();
    expect(viewers[0].of('screen:state')).toHaveLength(0);

    send(host, { type: 'screen:start', quality: '1080p60' });
    expect(rm.getScreenStats().live).toBe(0);
    send(host, { type: 'screen:live' });
    expect(rm.getScreen('TELA')!.live).toBe(true);
    expect(rm.getScreenStats().live).toBe(1);
    expect(viewers[0].last('screen:state').screen.live).toBe(true);
  });

  it('quem não é Host não inicia, não marca ao vivo e não para (nada vaza)', () => {
    const { host, viewers: [guest, other] } = room(2);
    send(guest, { type: 'screen:start', quality: '720p30' });
    expect(rm.getScreen('TELA')).toBeNull();
    for (const s of [host, guest, other]) expect(s.of('screen:state')).toHaveLength(0);

    send(host, { type: 'screen:start', quality: '720p30' });
    for (const s of [host, guest, other]) s.clear();
    send(guest, { type: 'screen:live' });
    send(guest, { type: 'screen:stop' });
    expect(rm.getScreen('TELA')).toMatchObject({ live: false });
    for (const s of [host, guest, other]) expect(s.of('screen:state')).toHaveLength(0);
  });

  it('screen:stop encerra para todos e endScreen é idempotente', () => {
    const { host, viewers, all } = room(2);
    send(host, { type: 'screen:start', quality: '720p30' });
    send(host, { type: 'screen:live' });
    for (const s of all) s.clear();
    send(host, { type: 'screen:stop' });
    for (const s of all) expect(s.last('screen:state').screen).toBeNull();
    expect(rm.getScreen('TELA')).toBeNull();
    expect(rm.getScreenStats().live).toBe(0);

    for (const s of all) s.clear();
    rm.endScreen(rm.getOrCreateRoom('TELA'), 'stopped');
    for (const s of [host, ...viewers]) expect(s.of('screen:state')).toHaveLength(0);
  });

  it('quem entra depois recebe o room:state já com a transmissão', () => {
    const { host } = room(0);
    send(host, { type: 'screen:start', quality: '2160p30' });
    const late = connect('TELA', 'late');
    expect(late.last('room:state').state.screen).toMatchObject({ quality: '2160p30' });
  });

  it('a transmissão não vai para o que o Redis guarda', async () => {
    const { host } = room(0);
    send(host, { type: 'screen:start', quality: '720p30' });
    send(host, { type: 'media:set', media: { url: 'https://exemplo.test/a.mkv', title: 'Ep', duration: 100 } });
    await vi.advanceTimersByTimeAsync(1000);
    const saved = store.rooms.get('TELA');
    expect(saved).toBeDefined();
    expect(JSON.stringify(saved)).not.toContain('screen');
    expect(JSON.stringify(saved)).not.toContain('lunio/TELA');
  });
});
