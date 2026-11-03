import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RoomManager } from '../roomServer';
import type { PersistedRoom, RoomStore } from '../roomStore';
import { config } from '../config';
import { getScreenUsage, resetScreenUsageForTests } from '../screenUsage';

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
  resetScreenUsageForTests();
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

describe('transmissão de tela: chave, rotação e fim automático', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  const KEY2 = Buffer.alloc(32, 9).toString('base64');

  /** Sala com a transmissão já iniciada e a época 1 enviada pelo Host. */
  function streaming(guests: number) {
    const r = room(guests);
    send(r.host, { type: 'screen:start', quality: '1080p60' });
    send(r.host, { type: 'screen:key', epoch: 1, key: KEY });
    for (const s of r.all) s.clear();
    return r;
  }

  it('repassa a chave aos espectadores e não devolve ao Host', () => {
    const { host, viewers } = room(2);
    send(host, { type: 'screen:start', quality: '1080p60' });
    send(host, { type: 'screen:key', epoch: 1, key: KEY });
    for (const v of viewers) expect(v.last('screen:key')).toEqual({ type: 'screen:key', epoch: 1, key: KEY });
    expect(host.of('screen:key')).toHaveLength(0);
  });

  it('a chave não aparece em room:state, screen:state nem no console', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { host, viewers, all } = room(1);
    send(host, { type: 'screen:start', quality: '1080p60' });
    send(host, { type: 'screen:key', epoch: 1, key: KEY });
    send(host, { type: 'screen:live' });
    connect('TELA', 'late');
    const states = all.flatMap((s) => [...s.of('room:state'), ...s.of('screen:state')]);
    expect(states.length).toBeGreaterThan(0);
    expect(JSON.stringify(states)).not.toContain(KEY);
    expect(JSON.stringify(rm.getRoomState(rm.getOrCreateRoom('TELA')))).not.toContain(KEY);
    const logged = [console.log, console.warn, console.error].flatMap((fn) => vi.mocked(fn).mock.calls);
    expect(JSON.stringify(logged)).not.toContain(KEY);
    expect(viewers[0].last('screen:key').key).toBe(KEY); // o canal certo continua funcionando
  });

  it('quem entra depois recebe a chave atual; o Host que reconecta não', () => {
    const { host } = streaming(0);
    const late = connect('TELA', 'late');
    expect(late.last('screen:key')).toEqual({ type: 'screen:key', epoch: 1, key: KEY });
    expect(late.sent.findIndex((m) => m.type === 'screen:key')).toBeGreaterThan(late.sent.findIndex((m) => m.type === 'room:state'));

    rm.handleLeave(asWs(host));
    const back = connect('TELA', 'host');
    expect(back.of('screen:key')).toHaveLength(0);
  });

  it('ignora chave ruim, época que volta atrás e chave diferente na mesma época', () => {
    const { host, viewers: [v] } = streaming(1);
    const bad = [
      { epoch: 2, key: Buffer.alloc(31, 1).toString('base64') },
      { epoch: 0, key: KEY2 },
      { epoch: 2, key: 123 },
      { epoch: 1, key: KEY2 },
    ];
    for (const b of bad) send(host, { type: 'screen:key', ...b });
    expect(v.of('screen:key')).toHaveLength(0);
    send(host, { type: 'screen:key', epoch: 3, key: KEY2 });
    expect(v.last('screen:key')).toEqual({ type: 'screen:key', epoch: 3, key: KEY2 });
    v.clear();
    send(host, { type: 'screen:key', epoch: 2, key: KEY }); // época menor que a atual (3)
    expect(v.of('screen:key')).toHaveLength(0);
  });

  it('ignora chave e uso de quem não é o Host', () => {
    const { viewers: [a, b] } = streaming(2);
    send(a, { type: 'screen:key', epoch: 5, key: KEY2 });
    send(a, { type: 'screen:usage', bytes: 1000 });
    expect(b.of('screen:key')).toHaveLength(0);
    const late = connect('TELA', 'late');
    expect(late.last('screen:key').epoch).toBe(1);
  });

  it('expulsar ou banir pede a rotação (uma só em 500 ms) e o expulso não recebe a época nova', () => {
    const { host, viewers: [a, b, c] } = streaming(3);
    send(host, { type: 'room:kick', targetUserId: 'g1' });
    send(host, { type: 'room:ban', targetUserId: 'g2' });
    expect(host.of('screen:rotate_key')).toHaveLength(0);
    vi.advanceTimersByTime(500);
    expect(host.of('screen:rotate_key')).toHaveLength(1);

    a.clear();
    b.clear();
    send(host, { type: 'screen:key', epoch: 2, key: KEY2 });
    expect(c.last('screen:key')).toEqual({ type: 'screen:key', epoch: 2, key: KEY2 });
    expect(a.of('screen:key')).toHaveLength(0);
    expect(b.of('screen:key')).toHaveLength(0);
  });

  it('espectador que sai de vez faz o Host receber o pedido de rotação', () => {
    const { host, viewers: [a] } = streaming(2);
    send(a, { type: 'room:leave' });
    vi.advanceTimersByTime(4000);
    vi.advanceTimersByTime(500);
    expect(host.of('screen:rotate_key')).toHaveLength(1);
  });

  it('trocar o Host encerra a transmissão e o novo Host não a herda', () => {
    const { host, viewers: [a], all } = streaming(1);
    send(host, { type: 'room:transfer_host', newHostId: 'g1' });
    for (const s of all) expect(s.last('screen:state').screen).toBeNull();
    expect(rm.getScreen('TELA')).toBeNull();
    send(a, { type: 'screen:key', epoch: 9, key: KEY2 });
    expect(host.of('screen:key')).toHaveLength(0);
  });

  it('passar o controle para si mesmo não encerra a transmissão', () => {
    const { host } = streaming(1);
    send(host, { type: 'room:transfer_host', newHostId: 'host' });
    expect(rm.getScreen('TELA')).not.toBeNull();
  });

  it('o Host sair de vez encerra a transmissão para quem fica', () => {
    const { host, viewers: [a] } = streaming(1);
    send(host, { type: 'screen:live' });
    expect(rm.getScreenStats().live).toBe(1);
    rm.handleLeave(asWs(host));
    vi.advanceTimersByTime(4000);
    expect(a.last('screen:state').screen).toBeNull();
    expect(rm.getScreenStats().live).toBe(0);
  });

  it('sala que esvazia e fecha não deixa transmissão nem timer pendurado', () => {
    const { host, viewers: [a] } = streaming(1);
    send(a, { type: 'room:leave' });
    vi.advanceTimersByTime(4000); // pedido de rotação agendado (500 ms)
    rm.handleLeave(asWs(host));
    vi.advanceTimersByTime(4000 + 30_000 + 1000);
    expect(rm.getScreen('TELA')).toBeNull();
    expect(rm.getRoomInfo('TELA').exists).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('transmissão de tela: medidor de uso', () => {
  it('conta o que o Host relata (delta) vezes os espectadores presentes', () => {
    const { host } = room(2);
    send(host, { type: 'screen:start', quality: '1080p60' });
    send(host, { type: 'screen:usage', bytes: 400 });
    expect(getScreenUsage()).toMatchObject({ hostBytes: 400, estimatedEgressBytes: 800 });
    send(host, { type: 'screen:usage', bytes: 1000 });
    expect(getScreenUsage()).toMatchObject({ hostBytes: 1000, estimatedEgressBytes: 2000 });
  });

  it('ignora contador que volta atrás, valor absurdo, lixo e quem não é o Host', () => {
    const { host, viewers: [a] } = room(2);
    send(host, { type: 'screen:start', quality: '1080p60' });
    send(host, { type: 'screen:usage', bytes: 1000 });
    send(host, { type: 'screen:usage', bytes: 500 });
    send(host, { type: 'screen:usage', bytes: 1e15 });
    send(host, { type: 'screen:usage', bytes: 'muito' });
    send(host, { type: 'screen:usage' });
    send(a, { type: 'screen:usage', bytes: 5000 });
    expect(getScreenUsage().hostBytes).toBe(1000);
    send(host, { type: 'screen:usage', bytes: 1200 }); // o contador guardado não foi corrompido
    expect(getScreenUsage().hostBytes).toBe(1200);
  });

  it('sem transmissão não conta nada', () => {
    const { host } = room(1);
    send(host, { type: 'screen:usage', bytes: 1000 });
    expect(getScreenUsage().hostBytes).toBe(0);
  });
});

describe('transmissão de tela: Host que perde a liderança na graça de 4 s', () => {
  it('quem assume a liderança encerra a transmissão e o Host antigo não publica mais', () => {
    const { host, viewers: [a] } = room(1);
    send(host, { type: 'screen:start', quality: '1080p60' });
    send(host, { type: 'screen:live' });
    a.clear();

    rm.handleLeave(asWs(host)); // o Host cai (recarregou a página)
    connect('TELA', 'late'); // alguém entra na graça e vira Host
    expect(rm.getRoomState(rm.getOrCreateRoom('TELA')).hostId).toBe('late');
    const back = connect('TELA', 'host'); // o Host antigo volta antes dos 4 s

    expect(rm.getScreen('TELA')).toBeNull();
    expect(a.last('screen:state').screen).toBeNull();
    expect(rm.isScreenBroadcaster('TELA', 'host')).toBe(false);
    expect(back.last('room:state').state.screen).toBeNull();
    expect(rm.getScreenStats().live).toBe(0);
  });
});

describe('transmissão de tela: quem está assistindo', () => {
  function live(guests: number) {
    const r = room(guests);
    send(r.host, { type: 'screen:start', quality: '720p30' });
    send(r.host, { type: 'screen:live' });
    for (const s of r.all) s.clear();
    return r;
  }
  const names = (m: any) => (m?.viewers ?? []).map((v: any) => v.username).sort();

  it('o Host recebe a lista quando alguém começa e quando para de assistir; os outros não recebem nada', () => {
    const { host, viewers: [a, b] } = live(2);
    send(a, { type: 'screen:watching', watching: true });
    expect(names(host.last('screen:viewers'))).toEqual(['g1']);
    send(b, { type: 'screen:watching', watching: true });
    expect(names(host.last('screen:viewers'))).toEqual(['g1', 'g2']);
    send(a, { type: 'screen:watching', watching: false });
    expect(names(host.last('screen:viewers'))).toEqual(['g2']);
    expect(a.of('screen:viewers')).toHaveLength(0);
    expect(b.of('screen:viewers')).toHaveLength(0);
  });

  it('repetir o mesmo estado não reenvia a lista', () => {
    const { host, viewers: [a] } = live(1);
    send(a, { type: 'screen:watching', watching: true });
    send(a, { type: 'screen:watching', watching: true });
    send(a, { type: 'screen:watching', watching: false });
    send(a, { type: 'screen:watching', watching: false });
    expect(host.of('screen:viewers')).toHaveLength(2);
  });

  it('a mesma pessoa em duas abas conta uma vez, e o Host (ou a aba dele) nunca conta', () => {
    const { host, viewers: [a] } = live(1);
    const tabOfA = connect('TELA', 'g1'); // segunda aba da mesma pessoa
    const tabOfHost = connect('TELA', 'host');
    send(a, { type: 'screen:watching', watching: true });
    send(tabOfA, { type: 'screen:watching', watching: true });
    send(tabOfHost, { type: 'screen:watching', watching: true });
    send(host, { type: 'screen:watching', watching: true });
    expect(names(host.last('screen:viewers'))).toEqual(['g1']);
  });

  it('expulsar, banir ou a pessoa sair de vez a tira da lista', () => {
    const { host, viewers: [a, b, c] } = live(3);
    for (const v of [a, b, c]) send(v, { type: 'screen:watching', watching: true });
    send(host, { type: 'room:kick', targetUserId: 'g1' });
    expect(names(host.last('screen:viewers'))).toEqual(['g2', 'g3']);
    send(host, { type: 'room:ban', targetUserId: 'g2' });
    expect(names(host.last('screen:viewers'))).toEqual(['g3']);
    send(c, { type: 'room:leave' });
    vi.advanceTimersByTime(4000);
    expect(names(host.last('screen:viewers'))).toEqual([]);
  });

  it('ao acabar a transmissão a lista some, e uma nova começa vazia', () => {
    const { host, viewers: [a] } = live(1);
    send(a, { type: 'screen:watching', watching: true });
    send(host, { type: 'screen:stop' });
    host.clear();
    send(host, { type: 'screen:start', quality: '720p30' });
    send(host, { type: 'screen:live' });
    const b = connect('TELA', 'late');
    send(b, { type: 'screen:watching', watching: true });
    expect(names(host.last('screen:viewers'))).toEqual(['late']);
  });

  it('entradas ruins e fora de hora são ignoradas', () => {
    const { host, viewers: [a] } = live(1);
    send(a, { type: 'screen:watching', watching: 'sim' });
    send(a, { type: 'screen:watching' });
    expect(host.of('screen:viewers')).toHaveLength(0);

    // sem transmissão ao vivo (só iniciada): ninguém assiste ainda
    const other = room(1, 'OUTRA');
    send(other.host, { type: 'screen:start', quality: '720p30' });
    send(other.viewers[0], { type: 'screen:watching', watching: true });
    expect(other.host.of('screen:viewers')).toHaveLength(0);
    // sem transmissão nenhuma
    const none = room(1, 'NENHUMA');
    send(none.viewers[0], { type: 'screen:watching', watching: true });
    expect(none.host.of('screen:viewers')).toHaveLength(0);
  });
});

describe('transmissão de tela: mudar a qualidade com a transmissão no ar', () => {
  function live() {
    const r = room(2);
    send(r.host, { type: 'screen:start', quality: '1080p60' });
    send(r.host, { type: 'screen:live' });
    for (const s of r.all) s.clear();
    return r;
  }

  it('o Host muda a qualidade e todos recebem o estado novo, sem perder o resto da transmissão', () => {
    const { host, all } = live();
    const before = rm.getScreen('TELA')!;
    send(host, { type: 'screen:quality', quality: '720p30' });
    const now = rm.getScreen('TELA')!;
    expect(now.quality).toBe('720p30');
    expect(now).toMatchObject({ sessionId: before.sessionId, path: before.path, live: true });
    for (const s of all) expect(s.last('screen:state').screen).toMatchObject({ quality: '720p30', live: true });
  });

  it('qualidade fora da tabela, ausente ou igual à atual não muda nem avisa ninguém', () => {
    const { host, all } = live();
    send(host, { type: 'screen:quality', quality: '1440p60' });
    send(host, { type: 'screen:quality' });
    send(host, { type: 'screen:quality', quality: '1080p60' });
    expect(rm.getScreen('TELA')!.quality).toBe('1080p60');
    for (const s of all) expect(s.of('screen:state')).toHaveLength(0);
  });

  it('quem não é o Host da transmissão não muda a qualidade, e sem transmissão nada acontece', () => {
    const { viewers: [a], all } = live();
    send(a, { type: 'screen:quality', quality: '720p30' });
    expect(rm.getScreen('TELA')!.quality).toBe('1080p60');
    for (const s of all) expect(s.of('screen:state')).toHaveLength(0);

    const none = room(1, 'SEMTELA');
    send(none.host, { type: 'screen:quality', quality: '720p30' });
    expect(none.host.of('screen:state')).toHaveLength(0);
  });
});
