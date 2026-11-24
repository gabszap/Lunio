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
let ipSeq = 1;

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

async function connect(
  roomId: string,
  id: string,
  username: string,
  opts?: { password?: string; accessToken?: string; ip?: string; manager?: RoomManager }
) {
  const manager = opts?.manager ?? rm;
  const s = new FakeSocket();
  manager.setSocketIp(asWs(s), opts?.ip ?? `10.0.0.${ipSeq++}`);
  await manager.handleClientMessage(
    asWs(s),
    JSON.stringify({
      type: 'room:join',
      roomId,
      password: opts?.password,
      accessToken: opts?.accessToken,
      user: { id, username },
    })
  );
  return s;
}

async function send(s: FakeSocket, msg: object, manager: RoomManager = rm) {
  await manager.handleClientMessage(asWs(s), JSON.stringify(msg));
}

beforeEach(() => {
  savedRooms = new Map();
  rm = new RoomManager(makeStore());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('configurações da sala (nome, pública/privada, senha) e persistência', () => {
  it('Host define nome, torna privada com senha, bloqueia entrada sem/com senha errada e libera com senha certa', async () => {
    const host = await connect('PRIV1', 'h', 'Host');

    // Espectador não consegue alterar settings
    const guest0 = await connect('PRIV1', 'g0', 'Guest0');
    await send(guest0, { type: 'room:settings', name: 'Hack', visibility: 'private' });
    expect(rm.getRoomInfo('PRIV1').name).toBeUndefined();
    expect(rm.getRoomInfo('PRIV1').visibility).toBe('public');

    // Host configura nome, privada e senha (com espaços para validar trim consistente)
    await send(host, { type: 'room:settings', name: 'Maratona JoJo', visibility: 'private', password: '  segredo123  ' });
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
    const intruder1 = await connect('PRIV1', 'g1', 'SemSenha');
    expect(intruder1.last('error')).toMatchObject({ code: 'password_required' });
    expect(intruder1.last('room:state')).toBeUndefined();

    // Spoofing do hostId SEM accessToken assinado não burla a senha
    const spoofer = await connect('PRIV1', 'h', 'Impostor');
    expect(spoofer.last('error')).toMatchObject({ code: 'password_required' });
    expect(spoofer.last('room:state')).toBeUndefined();

    // Senha errada -> wrong_password
    const intruder2 = await connect('PRIV1', 'g2', 'Errada', { password: 'errado' });
    expect(intruder2.last('error')).toMatchObject({ code: 'wrong_password' });
    expect(intruder2.last('room:state')).toBeUndefined();

    // Senha certa (inclusive com espaço nas pontas) -> entra normalmente
    const friend = await connect('PRIV1', 'g3', 'Amigo', { password: ' segredo123 ' });
    expect(friend.last('room:state')?.state).toMatchObject({
      name: 'Maratona JoJo',
      visibility: 'private',
      hasPassword: true,
    });

    // Sala privada sem senha = trancada (room_locked)
    await send(host, { type: 'room:settings', password: null });
    const blocked = await connect('PRIV1', 'g4', 'Trancada');
    expect(blocked.last('error')).toMatchObject({ code: 'room_locked' });

    // Voltar para pública libera entrada sem senha
    await send(host, { type: 'room:settings', visibility: 'public' });
    const openGuest = await connect('PRIV1', 'g5', 'Aberto');
    expect(openGuest.last('room:state')).toBeDefined();
  });

  it('aplica rate limit em tentativas repetidas de senha pelo WebSocket', async () => {
    const host = await connect('RATE1', 'h', 'Host');
    await send(host, { type: 'room:settings', visibility: 'private', password: 'certa' });

    const attackerIp = '203.0.113.77';
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const s = await connect('RATE1', `atk${i}`, 'Atacante', { password: `chute${i}`, ip: attackerIp });
      if (s.last('error')?.code === 'rate_limited') {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it('persiste e restaura nome, visibilidade, senha, pedidos e histórico de chat no Redis', async () => {
    const host = await connect('PERS1', 'h', 'Host');
    const hostToken = host.last('room:state')?.accessToken as string;
    expect(hostToken).toBeTruthy();

    const guest = await connect('PERS1', 'g', 'Gui');
    await send(host, { type: 'room:settings', name: 'Cinema', visibility: 'private', password: 'abc', autoPauseOnBuffer: true });
    await send(guest, { type: 'request:add', url: 'https://cdn.example/ep1.mp4', title: 'Ep 1' });
    await send(guest, { type: 'chat:send', text: 'Salve galera!' });

    await rm.flushPersistence();
    const persisted = savedRooms.get('PERS1')!;
    expect(persisted.name).toBe('Cinema');
    expect(persisted.visibility).toBe('private');
    expect(persisted.passwordHash).toMatch(/^[a-f0-9]{32}:[a-f0-9]{64}$/);
    expect(persisted.passwordHash).not.toBe('abc');
    expect(persisted.autoPauseOnBuffer).toBe(true);
    expect(persisted.requests).toHaveLength(1);
    expect(persisted.chatHistory?.some((m) => m.text === 'Salve galera!')).toBe(true);

    // parsePersistedRoom aceita hash válido e rejeita hash malformado
    const parsed = parsePersistedRoom(JSON.parse(JSON.stringify(persisted)));
    expect(parsed?.name).toBe('Cinema');
    expect(parsed?.passwordHash).toBe(persisted.passwordHash);
    expect(parsed?.requests).toHaveLength(1);
    expect(parsed?.chatHistory?.some((m) => m.text === 'Salve galera!')).toBe(true);

    const parsedBadHash = parsePersistedRoom({ ...JSON.parse(JSON.stringify(persisted)), passwordHash: 'invalido:curto' });
    expect(parsedBadHash?.passwordHash).toBeUndefined();

    // Restaura num novo RoomManager
    const rm2 = new RoomManager(makeStore());
    expect(await rm2.restore()).toBe(1);

    // Host reconecta sem precisar de senha apresentando seu accessToken assinado
    const host2 = await connect('PERS1', 'h', 'Host', { accessToken: hostToken, manager: rm2 });
    expect(host2.last('room:state')?.state).toMatchObject({
      name: 'Cinema',
      visibility: 'private',
      hasPassword: true,
      autoPauseOnBuffer: true,
    });
    expect(host2.last('room:state')?.state.requests).toHaveLength(1);
    expect(host2.of('chat:message').some((m) => m.message.text === 'Salve galera!')).toBe(true);

    // Impostor com o mesmo userId do Host mas sem accessToken não passa
    const fakeHost = await connect('PERS1', 'h', 'Host', { manager: rm2 });
    expect(fakeHost.last('error')).toMatchObject({ code: 'password_required' });

    // Novo usuário ainda precisa da senha restaurada
    const newcomer = await connect('PERS1', 'n', 'Novo', { manager: rm2 });
    expect(newcomer.last('error')).toMatchObject({ code: 'password_required' });
  });
});

describe('trocar sala e auto-pause em buffering', () => {
  it('trocar sala remove o socket da sala anterior apenas quando a entrada na nova é autorizada', async () => {
    const s1 = await connect('OLD1', 'u1', 'Pedro');
    const s2 = await connect('OLD1', 'u2', 'Lucas');
    expect(rm.getRoomInfo('OLD1').members).toBe(2);

    // Sala destino privada com senha: falha sem senha NÃO deve ejetar u2 de OLD1
    const privHost = await connect('LOCK1', 'ph', 'PrivHost');
    await send(privHost, { type: 'room:settings', visibility: 'private', password: 'secret' });
    await send(s2, { type: 'room:join', roomId: 'LOCK1', user: { id: 'u2', username: 'Lucas' } });
    expect(s2.last('error')).toMatchObject({ code: 'password_required' });
    expect(rm.getRoomInfo('OLD1').members).toBe(2);
    expect(rm.isMember('OLD1', 'u2')).toBe(true);

    // Banimento é checado antes de senha (sem oráculo de senha) e não ejeta de OLD1
    const banHost = await connect('BAN1', 'bh', 'BanHost');
    const victim = await connect('BAN1', 'u2', 'Lucas');
    await send(banHost, { type: 'room:settings', visibility: 'private', password: 'secret' });
    await send(banHost, { type: 'room:ban', targetUserId: 'u2' });
    expect(victim.closeCode).toBe(4002);
    await send(s2, { type: 'room:join', roomId: 'BAN1', password: 'errada', user: { id: 'u2', username: 'Lucas' } });
    expect(s2.last('error')).toMatchObject({ code: 'banned' });
    expect(rm.isMember('OLD1', 'u2')).toBe(true);

    // Troca autorizada para NEW1 sai de OLD1 e entra em NEW1
    await send(s2, { type: 'room:join', roomId: 'NEW1', user: { id: 'u2', username: 'Lucas' } });
    expect(rm.getRoomInfo('OLD1').members).toBe(1);
    expect(rm.getRoomInfo('NEW1').members).toBe(1);
    expect(s1.last('members:update').members).toHaveLength(1);
  });

  it('autoPauseOnBuffer pausa para todos (inclusive quem travou), ignora heartbeat, retoma ao destravar ou sair e limpa em media:set', async () => {
    const host = await connect('BUF1', 'h', 'Host');
    const guest = await connect('BUF1', 'g', 'Gui');
    await send(host, { type: 'room:settings', autoPauseOnBuffer: true });
    await send(host, { type: 'media:set', media: { url: 'https://cdn.example/v.mp4', title: 'Video', duration: 120 } });
    await send(host, { type: 'client:readiness', ready: true, state: 'playing', currentTime: 10 });
    await send(guest, { type: 'client:readiness', ready: true, state: 'playing', currentTime: 10 });
    await send(host, { type: 'playback:play', position: 10 });
    host.clear();
    guest.clear();

    // Espectador trava em stalled -> pausa automaticamente com triggeredBy: 'system' (pausa também o próprio guest)
    await send(guest, { type: 'client:readiness', ready: false, state: 'stalled', currentTime: 10 });
    expect(host.last('playback:sync')).toMatchObject({ action: 'pause', triggeredBy: 'system', username: 'Gui' });
    expect(guest.last('playback:sync')).toMatchObject({ action: 'pause', triggeredBy: 'system', username: 'Gui' });

    // Heartbeat do espectador NÃO sobrescreve o estado nem retoma a sala prematuramente
    host.clear();
    await send(guest, { type: 'client:heartbeat', clientTime: Date.now(), currentTime: 10, rtt: 40 });
    expect(host.last('playback:sync')).toBeUndefined();

    // Espectador volta a ready -> retoma automaticamente
    await send(guest, { type: 'client:readiness', ready: true, state: 'ready', currentTime: 10 });
    expect(host.last('playback:sync')).toMatchObject({ action: 'play', triggeredBy: 'system', username: 'Sistema' });

    // Se o membro travado sair da sala, o auto-pause é limpo e a sala retoma para o Host
    vi.useFakeTimers();
    vi.advanceTimersByTime(11_000); // passa o cooldown de 10 s
    host.clear();
    await send(guest, { type: 'client:readiness', ready: false, state: 'stalled', currentTime: 25 });
    expect(host.last('playback:sync')).toMatchObject({ action: 'pause', username: 'Gui' });
    host.clear();
    rm.handleLeave(asWs(guest), true);
    expect(host.last('playback:sync')).toMatchObject({ action: 'play', triggeredBy: 'system' });

    // Trocar mídia (`media:set`) cancela timer pendente de auto-pause
    const guest2 = await connect('BUF1', 'g2', 'Ana');
    await send(guest2, { type: 'client:readiness', ready: true, state: 'playing', currentTime: 30 });
    vi.advanceTimersByTime(11_000);
    await send(guest2, { type: 'client:readiness', ready: false, state: 'stalled', currentTime: 30 });
    host.clear();
    await send(host, { type: 'media:set', media: { url: 'https://cdn.example/v2.mp4', title: 'Video 2', duration: 120 } });
    host.clear();
    vi.advanceTimersByTime(20_000);
    expect(host.last('playback:sync')).toBeUndefined();
  });
});
