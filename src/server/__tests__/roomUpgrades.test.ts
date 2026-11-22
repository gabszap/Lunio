import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RoomManager } from '../roomServer';
import { parsePersistedRoom, type PersistedRoom, type RoomStore } from '../roomStore';

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
let savedRooms: Map<string, PersistedRoom>;

function makeStore(): RoomStore {
  return {
    async save(room) {
      savedRooms.set(room.roomId, structuredClone(room));
    },
    async remove(roomId) {
      savedRooms.delete(roomId);
    },
    async loadAll() {
      return { rooms: Array.from(savedRooms.values()), closed: [] };
    },
  };
}

function connect(roomId: string, id: string, username: string, password?: string) {
  const s = new FakeSocket();
  rm.handleClientMessage(asWs(s), JSON.stringify({ type: 'room:join', roomId, password, user: { id, username } }));
  return s;
}

function send(s: FakeSocket, msg: object) {
  rm.handleClientMessage(asWs(s), JSON.stringify(msg));
}

beforeEach(() => {
  savedRooms = new Map();
  rm = new RoomManager(makeStore());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('configurações da sala (nome, pública/privada, senha) e persistência', () => {
  it('Host define nome, torna privada com senha, bloqueia entrada sem/com senha errada e libera com senha certa', () => {
    const host = connect('PRIV1', 'h', 'Host');

    // Espectador não consegue alterar settings
    const guest0 = connect('PRIV1', 'g0', 'Guest0');
    send(guest0, { type: 'room:settings', name: 'Hack', visibility: 'private' });
    expect(rm.getRoomInfo('PRIV1').name).toBeUndefined();
    expect(rm.getRoomInfo('PRIV1').visibility).toBe('public');

    // Host configura nome, privada e senha
    send(host, { type: 'room:settings', name: 'Maratona JoJo', visibility: 'private', password: 'segredo123' });
    const update = host.last('room:settings_update');
    expect(update).toEqual({
      type: 'room:settings_update',
      name: 'Maratona JoJo',
      visibility: 'private',
      hasPassword: true,
      autoPauseOnBuffer: false,
    });
    // Nunca vaza passwordHash no state
    expect(JSON.stringify(host.sent)).not.toContain('segredo123');

    // Novo visitante sem senha -> password_required
    const intruder1 = connect('PRIV1', 'g1', 'SemSenha');
    expect(intruder1.last('error')).toMatchObject({ code: 'password_required' });
    expect(intruder1.last('room:state')).toBeUndefined();

    // Senha errada -> wrong_password
    const intruder2 = connect('PRIV1', 'g2', 'Errada', 'errado');
    expect(intruder2.last('error')).toMatchObject({ code: 'wrong_password' });
    expect(intruder2.last('room:state')).toBeUndefined();

    // Senha certa -> entra normalmente
    const friend = connect('PRIV1', 'g3', 'Amigo', 'segredo123');
    expect(friend.last('room:state')?.state).toMatchObject({
      name: 'Maratona JoJo',
      visibility: 'private',
      hasPassword: true,
    });

    // Sala privada sem senha = trancada (room_locked)
    send(host, { type: 'room:settings', password: null });
    const blocked = connect('PRIV1', 'g4', 'Trancada');
    expect(blocked.last('error')).toMatchObject({ code: 'room_locked' });

    // Voltar para pública libera entrada sem senha
    send(host, { type: 'room:settings', visibility: 'public' });
    const openGuest = connect('PRIV1', 'g5', 'Aberto');
    expect(openGuest.last('room:state')).toBeDefined();
  });

  it('persiste e restaura nome, visibilidade, senha, pedidos e histórico de chat no Redis', async () => {
    const host = connect('PERS1', 'h', 'Host');
    const guest = connect('PERS1', 'g', 'Gui');
    send(host, { type: 'room:settings', name: 'Cinema', visibility: 'private', password: 'abc', autoPauseOnBuffer: true });
    send(guest, { type: 'request:add', url: 'https://cdn.example/ep1.mp4', title: 'Ep 1' });
    send(guest, { type: 'chat:send', text: 'Salve galera!' });

    await rm.flushPersistence();
    const persisted = savedRooms.get('PERS1')!;
    expect(persisted.name).toBe('Cinema');
    expect(persisted.visibility).toBe('private');
    expect(persisted.passwordHash).toBeTruthy();
    expect(persisted.passwordHash).not.toBe('abc');
    expect(persisted.autoPauseOnBuffer).toBe(true);
    expect(persisted.requests).toHaveLength(1);
    expect(persisted.chatHistory?.some((m) => m.text === 'Salve galera!')).toBe(true);

    // parsePersistedRoom aceita e preserva todos os campos
    const parsed = parsePersistedRoom(JSON.parse(JSON.stringify(persisted)));
    expect(parsed?.name).toBe('Cinema');
    expect(parsed?.requests).toHaveLength(1);
    expect(parsed?.chatHistory?.some((m) => m.text === 'Salve galera!')).toBe(true);

    // Restaura num novo RoomManager
    const rm2 = new RoomManager(makeStore());
    expect(await rm2.restore()).toBe(1);

    // Host reconecta sem precisar de senha e recebe pedidos + chat restaurados
    const host2 = new FakeSocket();
    rm2.handleClientMessage(asWs(host2), JSON.stringify({ type: 'room:join', roomId: 'PERS1', user: { id: 'h', username: 'Host' } }));
    expect(host2.last('room:state')?.state).toMatchObject({
      name: 'Cinema',
      visibility: 'private',
      hasPassword: true,
      autoPauseOnBuffer: true,
    });
    expect(host2.last('room:state')?.state.requests).toHaveLength(1);
    expect(host2.of('chat:message').some((m) => m.message.text === 'Salve galera!')).toBe(true);

    // Novo usuário ainda precisa da senha restaurada
    const newcomer = new FakeSocket();
    rm2.handleClientMessage(asWs(newcomer), JSON.stringify({ type: 'room:join', roomId: 'PERS1', user: { id: 'n', username: 'Novo' } }));
    expect(newcomer.last('error')).toMatchObject({ code: 'password_required' });
  });
});

describe('trocar sala, reações e auto-pause em buffering', () => {
  it('trocar sala remove o socket da sala anterior antes de entrar na nova', () => {
    const s1 = connect('OLD1', 'u1', 'Pedro');
    const s2 = connect('OLD1', 'u2', 'Lucas');
    expect(rm.getRoomInfo('OLD1').members).toBe(2);

    // u2 troca para NEW1 no mesmo socket
    send(s2, { type: 'room:join', roomId: 'NEW1', user: { id: 'u2', username: 'Lucas' } });
    expect(rm.getRoomInfo('OLD1').members).toBe(1);
    expect(rm.getRoomInfo('NEW1').members).toBe(1);
    expect(s1.last('members:update').members).toHaveLength(1);
  });

  it('transmite reações válidas com cooldown anti-spam e ignora inválidas', () => {
    vi.useFakeTimers();
    const host = connect('RX1', 'h', 'Host');
    const guest = connect('RX1', 'g', 'Gui');

    send(guest, { type: 'reaction:send', kind: 'fire' });
    expect(host.of('reaction:broadcast')).toHaveLength(1);
    expect(host.last('reaction:broadcast').reaction).toMatchObject({ kind: 'fire', username: 'Gui' });

    // Cooldown (< 500ms) bloqueia spam imediato
    send(guest, { type: 'reaction:send', kind: 'heart' });
    expect(host.of('reaction:broadcast')).toHaveLength(1);

    // Após 600ms aceita novamente
    vi.advanceTimersByTime(600);
    send(guest, { type: 'reaction:send', kind: 'heart' });
    expect(host.of('reaction:broadcast')).toHaveLength(2);

    // Tipo inválido é ignorado
    send(guest, { type: 'reaction:send', kind: 'invalid_emoji' });
    expect(host.of('reaction:broadcast')).toHaveLength(2);
  });

  it('autoPauseOnBuffer pausa quando espectador trava e retoma quando volta a ficar pronto', () => {
    const host = connect('BUF1', 'h', 'Host');
    const guest = connect('BUF1', 'g', 'Gui');
    send(host, { type: 'room:settings', autoPauseOnBuffer: true });
    send(host, { type: 'media:set', media: { url: 'https://cdn.example/v.mp4', title: 'Video', duration: 120 } });
    send(host, { type: 'client:readiness', ready: true, state: 'playing', currentTime: 10 });
    send(guest, { type: 'client:readiness', ready: true, state: 'playing', currentTime: 10 });
    send(host, { type: 'playback:play', position: 10 });
    host.clear();

    // Espectador trava em stalled -> pausa automaticamente
    send(guest, { type: 'client:readiness', ready: false, state: 'stalled', currentTime: 10 });
    expect(host.last('playback:sync')).toMatchObject({ action: 'pause', username: 'Gui' });

    // Espectador volta a ready -> retoma automaticamente
    send(guest, { type: 'client:readiness', ready: true, state: 'ready', currentTime: 10 });
    expect(host.last('playback:sync')).toMatchObject({ action: 'play', username: 'Sistema' });
  });
});
