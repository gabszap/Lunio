import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RoomManager } from '../roomServer';
import { parsePersistedRoom, type PersistedRoom, type RoomStore } from '../roomStore';
import { linkIdFor } from '../links';
import { PLAYLIST_MAX_ITEMS, REQUESTS_MAX_ITEMS } from '../../types/sync';

vi.mock('../media/resolver', () => ({ warmUpMedia: vi.fn() }));

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

function connect(roomId: string, id: string, username = id) {
  const s = new FakeSocket();
  rm.handleClientMessage(asWs(s), JSON.stringify({ type: 'room:join', roomId, user: { id, username } }));
  return s;
}
const send = (s: FakeSocket, msg: object) => rm.handleClientMessage(asWs(s), JSON.stringify(msg));
const stateOf = (roomId: string) => rm.getRoomState(rm.getOrCreateRoom(roomId));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-22T00:00:00.000Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  rm = new RoomManager();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('duração da sala (createdAt)', () => {
  it('parsePersistedRoom aceita JSON com createdAt e faz fallback para savedAt em JSON legado', () => {
    const base = {
      v: 1,
      roomId: 'DUR1',
      hostId: 'h',
      media: null,
      playlist: [],
      bans: [],
      playback: { playing: false, position: 0, rate: 1 },
      savedAt: 1_700_000_500_000,
    };
    const withCreated = parsePersistedRoom({ ...base, createdAt: 1_700_000_000_000 });
    expect(withCreated?.createdAt).toBe(1_700_000_000_000);

    const legacy = parsePersistedRoom(base);
    expect(legacy).not.toBeNull();
    expect(legacy?.createdAt).toBe(1_700_000_500_000);
  });

  it('envia createdAt em room:state e preserva após restore do RoomStore', async () => {
    const createdTs = Date.now();
    const saved: PersistedRoom[] = [];
    const store: RoomStore = {
      save: async (room) => {
        saved.push(room);
      },
      remove: async () => {},
      loadAll: async () => ({ rooms: saved.slice(-1), closed: [] }),
    };

    const first = new RoomManager(store);
    const host = new FakeSocket();
    first.handleClientMessage(asWs(host), JSON.stringify({ type: 'room:join', roomId: 'DUR2', user: { id: 'h', username: 'Host' } }));
    expect(host.last('room:state').state.createdAt).toBe(createdTs);

    vi.advanceTimersByTime(15_000);
    await first.flushPersistence();
    expect(saved.at(-1)?.createdAt).toBe(createdTs);

    const restored = new RoomManager(store);
    await restored.restore();
    const reHost = new FakeSocket();
    restored.handleClientMessage(asWs(reHost), JSON.stringify({ type: 'room:join', roomId: 'DUR2', user: { id: 'h', username: 'Host' } }));
    expect(reHost.last('room:state').state.createdAt).toBe(createdTs);
  });
});

describe('pedidos (requests) e regra da fila', () => {
  const reqMsg = (n: number) => ({
    type: 'request:add',
    url: `https://debrid.secret.test/token-xyz/ep${n}.mkv`,
    title: `Ep ${n}`,
    mimeType: 'video/x-matroska',
  });

  it('bloqueia playlist:add vindo de espectador', () => {
    const host = connect('REQ1', 'h', 'Host');
    const guest = connect('REQ1', 'g', 'Gui');
    send(guest, { type: 'playlist:add', url: 'https://exemplo.test/ep1.mkv', title: 'Ep 1' });
    expect(stateOf('REQ1').playlist).toHaveLength(0);
    send(host, { type: 'playlist:add', url: 'https://exemplo.test/ep1.mkv', title: 'Ep 1' });
    expect(stateOf('REQ1').playlist).toHaveLength(1);
  });

  it('espectador cria pedido com link real só para ele e lk_… para o Host e outros', () => {
    const host = connect('REQ2', 'h', 'Host');
    const guest = connect('REQ2', 'g', 'Gui');
    const other = connect('REQ2', 'o', 'Outro');
    const secretUrl = 'https://debrid.secret.test/token-xyz/ep1.mkv';
    const opaqueId = linkIdFor('REQ2', secretUrl);

    send(guest, reqMsg(1));

    const guestUpdate = guest.last('requests:update');
    const hostUpdate = host.last('requests:update');
    const otherUpdate = other.last('requests:update');

    expect(guestUpdate.requests).toHaveLength(1);
    expect(guestUpdate.requests[0].url).toBe(secretUrl);
    expect(hostUpdate.requests[0].url).toBe(opaqueId);
    expect(otherUpdate.requests[0].url).toBe(opaqueId);
  });

  it('deduplica contra pedidos e fila e respeita limite REQUESTS_MAX_ITEMS', () => {
    const host = connect('REQ3', 'h', 'Host');
    const guest = connect('REQ3', 'g', 'Gui');

    send(host, { type: 'playlist:add', url: 'https://debrid.secret.test/token-xyz/ep1.mkv', title: 'Ep 1' });
    send(guest, reqMsg(1)); // já está na fila
    expect(stateOf('REQ3').requests).toHaveLength(0);

    send(guest, reqMsg(2));
    send(guest, reqMsg(2)); // duplicado nos pedidos
    expect(stateOf('REQ3').requests).toHaveLength(1);

    for (let i = 3; i <= REQUESTS_MAX_ITEMS + 10; i++) {
      send(guest, reqMsg(i));
    }
    expect(stateOf('REQ3').requests).toHaveLength(REQUESTS_MAX_ITEMS);
  });

  it('autor cancela próprio pedido, Host recusa qualquer um, outro espectador não remove alheio', () => {
    const host = connect('REQ4', 'h', 'Host');
    const guestA = connect('REQ4', 'a', 'Ana');
    const guestB = connect('REQ4', 'b', 'Bia');

    send(guestA, reqMsg(1));
    send(guestA, reqMsg(2));
    const [r1, r2] = stateOf('REQ4').requests!;

    send(guestB, { type: 'request:remove', itemId: r1.id });
    expect(stateOf('REQ4').requests).toHaveLength(2);

    send(guestA, { type: 'request:remove', itemId: r1.id });
    expect(stateOf('REQ4').requests?.map((r) => r.id)).toEqual([r2.id]);

    send(host, { type: 'request:remove', itemId: r2.id });
    expect(stateOf('REQ4').requests).toHaveLength(0);
  });

  it('só o Host aprova pedido para a fila mantendo autor e link opaco', () => {
    const host = connect('REQ5', 'h', 'Host');
    const guest = connect('REQ5', 'g', 'Gui');
    const secretUrl = 'https://debrid.secret.test/token-xyz/ep1.mkv';
    const opaqueId = linkIdFor('REQ5', secretUrl);

    send(guest, reqMsg(1));
    const [req] = stateOf('REQ5').requests!;

    // Espectador não aprova
    send(guest, { type: 'request:approve', itemId: req.id });
    expect(stateOf('REQ5').requests).toHaveLength(1);
    expect(stateOf('REQ5').playlist).toHaveLength(0);

    // Host aprova para a fila
    send(host, { type: 'request:approve', itemId: req.id });
    expect(stateOf('REQ5').requests).toHaveLength(0);
    expect(stateOf('REQ5').playlist).toHaveLength(1);
    expect(stateOf('REQ5').playlist![0]).toMatchObject({ addedById: 'g', addedBy: 'Gui' });
    expect(host.last('playlist:update').playlist[0].url).toBe(opaqueId);
    expect(guest.last('playlist:update').playlist[0].url).toBe(secretUrl);
  });

  it('aprovar com playNow: true envia request:play com link opaco e resolve media:set sem vazar URL', () => {
    const host = connect('REQ6', 'h', 'Host');
    const guest = connect('REQ6', 'g', 'Gui');
    const secretUrl = 'https://debrid.secret.test/token-xyz/ep9.mkv';
    const opaqueId = linkIdFor('REQ6', secretUrl);

    send(guest, reqMsg(9));
    const [req] = stateOf('REQ6').requests!;

    send(host, { type: 'request:approve', itemId: req.id, playNow: true });
    expect(stateOf('REQ6').requests).toHaveLength(0);

    const playMsg = host.last('request:play');
    expect(playMsg).toBeDefined();
    expect(playMsg.item.url).toBe(opaqueId);
    expect(guest.last('request:play')).toBeUndefined();

    // Host responde carregando a mídia pelo id opaco
    send(host, {
      type: 'media:set',
      media: { url: playMsg.item.url, title: playMsg.item.title, duration: 120 },
    });
    expect(stateOf('REQ6').media?.url).toBe(secretUrl);
    expect(stateOf('REQ6').media?.ownerId).toBe('g');
    expect(host.last('media:sync').media.url).toBe(opaqueId);
    expect(guest.last('media:sync').media.url).toBe(secretUrl);
  });

  it('não descarta pedido ao aprovar quando a fila já atingiu o limite', () => {
    const host = connect('REQ7', 'h', 'Host');
    const guest = connect('REQ7', 'g', 'Gui');

    for (let i = 1; i <= PLAYLIST_MAX_ITEMS; i++) {
      send(host, {
        type: 'playlist:add',
        url: `https://cdn.example/queue-${i}.mp4`,
        title: `Fila ${i}`,
      });
    }
    expect(stateOf('REQ7').playlist).toHaveLength(PLAYLIST_MAX_ITEMS);

    send(guest, reqMsg(99));
    const [req] = stateOf('REQ7').requests!;
    host.clear();

    send(host, { type: 'request:approve', itemId: req.id });
    expect(stateOf('REQ7').requests).toHaveLength(1);
    expect(stateOf('REQ7').playlist).toHaveLength(PLAYLIST_MAX_ITEMS);
    expect(host.last('error')).toMatchObject({ type: 'error' });
  });

  it('aprovar com playNow: true envia id opaco limpo mesmo quando o pedido tem #fragment sobre link base já em media', () => {
    const host = connect('REQ8', 'h', 'Host');
    const guest1 = connect('REQ8', 'g1', 'Ana');
    const guest2 = connect('REQ8', 'g2', 'Gui');
    const baseUrl = 'https://debrid.secret.test/token-xyz/ep10.mkv';
    const fragUrl = `${baseUrl}#t=30`;
    const opaqueId = linkIdFor('REQ8', baseUrl);

    // guest1 coloca baseUrl como mídia atual (Host não é o dono)
    send(guest1, { type: 'request:add', url: baseUrl, title: 'Ep 10' });
    const [req1] = stateOf('REQ8').requests!;
    send(host, { type: 'request:approve', itemId: req1.id, playNow: true });
    send(host, { type: 'media:set', media: { url: host.last('request:play').item.url, title: 'Ep 10', duration: 120 } });

    // guest2 pede o mesmo link com #fragment; request:play deve chegar como lk_… limpo (sem #t=30)
    send(guest2, { type: 'request:add', url: fragUrl, title: 'Ep 10 (30s)' });
    const [req2] = stateOf('REQ8').requests!;
    send(host, { type: 'request:approve', itemId: req2.id, playNow: true });
    const playMsg = host.last('request:play');
    expect(playMsg).toBeDefined();
    expect(playMsg.item.url).toBe(opaqueId);

    // Host consegue carregar media:set com o id limpo sem vazar URL
    send(host, { type: 'media:set', media: { url: playMsg.item.url, title: playMsg.item.title, duration: 120 } });
    expect(stateOf('REQ8').media?.url).toBe(baseUrl);
    expect(host.last('media:sync').media.url).toBe(opaqueId);
  });
});
