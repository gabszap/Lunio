import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RoomManager } from '../roomServer';
import { verifyToken } from '../access';

/** WebSocket falso: guarda o que o servidor enviou e o código com que fechou. */
class FakeSocket {
  readyState = 1; // WebSocket.OPEN
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
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  rm = new RoomManager();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('entrar e sair', () => {
  it('o primeiro a entrar vira Host e recebe o estado e um token de sessão', () => {
    const host = connect('SALA1', 'u1', 'Ana');
    const state = host.last('room:state');
    expect(state.state.hostId).toBe('u1');
    expect(state.state.members).toHaveLength(1);
    expect(state.state.members[0]).toMatchObject({ id: 'u1', username: 'Ana', isHost: true });
    expect(verifyToken(state.accessToken)).toMatchObject({ k: 'room', r: 'SALA1', u: 'u1' });
  });

  it('o segundo entra como espectador e o Host é avisado', () => {
    const host = connect('SALA1', 'u1');
    host.clear();
    const guest = connect('SALA1', 'u2', 'Bia');
    expect(guest.last('room:state').state.hostId).toBe('u1');
    expect(host.last('members:update').members.map((m: any) => m.id).sort()).toEqual(['u1', 'u2']);
    expect(host.of('chat:message').some((m) => m.message.text.includes('Bia entrou na sala'))).toBe(true);
  });

  it('quem sai de vez some da lista depois da tolerância de 4 s e é anunciado', () => {
    const host = connect('SALA1', 'u1');
    const guest = connect('SALA1', 'u2', 'Bia');
    host.clear();
    rm.handleLeave(asWs(guest));
    // durante a tolerância ainda é considerado membro (recarregar a página não derruba ninguém)
    expect(rm.isMember('SALA1', 'u2')).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(rm.isMember('SALA1', 'u2')).toBe(false);
    expect(host.of('chat:message').some((m) => m.message.text.includes('Bia saiu da sala'))).toBe(true);
    expect(host.last('members:update').members.map((m: any) => m.id)).toEqual(['u1']);
  });

  it('voltar dentro dos 4 s é reconexão silenciosa (sem "saiu"/"entrou")', () => {
    const host = connect('SALA1', 'u1');
    const guest = connect('SALA1', 'u2', 'Bia');
    rm.handleLeave(asWs(guest));
    host.clear();
    vi.advanceTimersByTime(2000);
    connect('SALA1', 'u2', 'Bia');
    vi.advanceTimersByTime(10_000);
    expect(host.of('chat:message').filter((m) => /saiu|entrou/.test(m.message.text))).toHaveLength(0);
    expect(rm.isMember('SALA1', 'u2')).toBe(true);
  });

  it('segunda aba com o mesmo usuário recebe outro ID e nunca rouba o Host', () => {
    connect('SALA1', 'u1');
    const second = connect('SALA1', 'u1');
    const assigned = second.last('room:state').assignedUserId;
    expect(assigned).toMatch(/^u1_tab\d{4}$/);
    expect(stateOf('SALA1').hostId).toBe('u1');
  });

  it('dados de entrada inválidos são recusados', () => {
    const s = new FakeSocket();
    rm.handleClientMessage(asWs(s), JSON.stringify({ type: 'room:join', roomId: 'a b/../c', user: { id: 'x', username: 'y' } }));
    expect(s.last('error')).toMatchObject({ code: 'bad_request' });
    expect(rm.getRoomInfo('a b/../c').exists).toBe(false);
  });

  it('mensagem sem entrar numa sala é recusada', () => {
    const s = new FakeSocket();
    send(s, { type: 'playback:play', position: 5 });
    expect(s.last('error')).toBeTruthy();
  });
});

describe('Host autoritativo', () => {
  it('só o Host controla play/pause/seek/velocidade; o espectador é ignorado', () => {
    const host = connect('SALA1', 'u1');
    const guest = connect('SALA1', 'u2');
    host.clear();
    guest.clear();

    send(guest, { type: 'playback:play', position: 30 });
    send(guest, { type: 'playback:seek', position: 99 });
    send(guest, { type: 'playback:rate', rate: 2 });
    send(guest, { type: 'playback:pause', position: 10 });
    expect(host.of('playback:sync')).toHaveLength(0);
    expect(stateOf('SALA1').playback).toMatchObject({ playing: false, position: 0, rate: 1 });

    send(host, { type: 'playback:play', position: 12 });
    expect(guest.last('playback:sync')).toMatchObject({ action: 'play', triggeredBy: 'u1' });
    expect(stateOf('SALA1').playback).toMatchObject({ playing: true });

    send(host, { type: 'playback:seek', position: 40 });
    expect(guest.last('playback:sync')).toMatchObject({ action: 'seek' });
    expect(guest.last('playback:sync').playback.position).toBeCloseTo(40, 0);

    send(host, { type: 'playback:rate', rate: 1.5 });
    expect(stateOf('SALA1').playback.rate).toBe(1.5);
    send(host, { type: 'playback:rate', rate: 99 });
    expect(stateOf('SALA1').playback.rate).toBe(3); // limitado

    send(host, { type: 'playback:pause', position: 41 });
    expect(stateOf('SALA1').playback).toMatchObject({ playing: false, position: 41 });
  });

  it('a posição avança sozinha enquanto toca', () => {
    const host = connect('SALA1', 'u1');
    send(host, { type: 'playback:play', position: 10 });
    vi.advanceTimersByTime(5000);
    expect(stateOf('SALA1').playback.position).toBeCloseTo(15, 0);
  });

  it('heartbeat é só telemetria: não mexe na timeline da sala', () => {
    const host = connect('SALA1', 'u1');
    const guest = connect('SALA1', 'u2');
    send(host, { type: 'playback:play', position: 10 });
    const before = stateOf('SALA1').playback.position;
    send(guest, { type: 'client:heartbeat', clientTime: Date.now() - 30, currentTime: 9999, state: 'playing' });
    send(host, { type: 'client:heartbeat', clientTime: Date.now() - 30, currentTime: 0, state: 'playing' });
    expect(stateOf('SALA1').playback.position).toBeCloseTo(before, 1);
    expect(guest.last('server:heartbeat_ack')).toBeTruthy();
    const member = stateOf('SALA1').members.find((m) => m.id === 'u2')!;
    expect(member.currentTime).toBe(9999);
  });

  it('só o Host troca a mídia; a sala guarda as faixas disponíveis mas não a escolhida', () => {
    const host = connect('SALA1', 'u1');
    const guest = connect('SALA1', 'u2');
    const media = { url: '/api/uploads/x/a.mkv', title: 'Filme', duration: 0, audioTracks: [{ id: '1', label: 'JP' }, { id: '2', label: 'PT' }] };

    send(guest, { type: 'media:set', media });
    expect(stateOf('SALA1').media).toBeNull();

    send(host, { type: 'media:set', media });
    expect(guest.last('media:sync').media).toMatchObject({ title: 'Filme', generation: 1 });
    expect(guest.last('media:sync').media.audioTracks).toHaveLength(2);

    // seleção de faixa é local: o servidor ignora e nada vai para os outros
    guest.clear();
    send(host, { type: 'track:audio', trackId: '2' });
    send(host, { type: 'track:subtitle', trackId: 'x' });
    expect(guest.sent).toHaveLength(0);
    expect(stateOf('SALA1')).not.toHaveProperty('audioTrack');
    expect(stateOf('SALA1')).not.toHaveProperty('subtitleTrack');
  });

  it('trocar a mídia zera a posição e incrementa a geração', () => {
    const host = connect('SALA1', 'u1');
    const m = { url: 'http://a/b.mkv', title: 'A', duration: 0 };
    send(host, { type: 'media:set', media: m });
    send(host, { type: 'playback:seek', position: 50 });
    send(host, { type: 'media:set', media: { ...m, title: 'B' } });
    expect(stateOf('SALA1').media).toMatchObject({ title: 'B', generation: 2 });
    expect(stateOf('SALA1').playback).toMatchObject({ playing: false, position: 0 });
  });
});

describe('passar o Host', () => {
  it('o Host entrega o controle; o antigo Host perde o poder', () => {
    const host = connect('SALA1', 'u1');
    const guest = connect('SALA1', 'u2');
    send(host, { type: 'room:transfer_host', newHostId: 'u2' });
    expect(stateOf('SALA1').hostId).toBe('u2');
    expect(rm.isHostMember('SALA1', 'u2')).toBe(true);
    expect(rm.isHostMember('SALA1', 'u1')).toBe(false);

    guest.clear();
    send(host, { type: 'playback:play', position: 5 });
    expect(guest.of('playback:sync')).toHaveLength(0);
    send(guest, { type: 'playback:play', position: 5 });
    expect(guest.last('playback:sync')).toMatchObject({ action: 'play' });
  });

  it('espectador não consegue passar o Host', () => {
    connect('SALA1', 'u1');
    const guest = connect('SALA1', 'u2');
    send(guest, { type: 'room:transfer_host', newHostId: 'u2' });
    expect(stateOf('SALA1').hostId).toBe('u1');
  });

  it('se o Host sai de vez, o próximo vira Host', () => {
    const host = connect('SALA1', 'u1');
    connect('SALA1', 'u2');
    rm.handleLeave(asWs(host));
    vi.advanceTimersByTime(4000);
    expect(stateOf('SALA1').hostId).toBe('u2');
  });
});

describe('moderação', () => {
  it('kick: o alvo recebe o aviso, a conexão fecha com 4001 e ele não é banido', () => {
    const host = connect('SALA1', 'u1');
    const guest = connect('SALA1', 'u2', 'Bia');
    host.clear();
    send(host, { type: 'room:kick', targetUserId: 'u2' });
    expect(guest.last('error')).toMatchObject({ code: 'kicked' });
    expect(guest.closeCode).toBe(4001);
    expect(host.of('chat:message').some((m) => m.message.text.includes('Bia foi expulso'))).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(rm.isMember('SALA1', 'u2')).toBe(false);
    // pode voltar
    const again = connect('SALA1', 'u2', 'Bia');
    expect(again.last('room:state')).toBeTruthy();
  });

  it('espectador não expulsa ninguém e o Host não expulsa a si mesmo', () => {
    const host = connect('SALA1', 'u1');
    const guest = connect('SALA1', 'u2');
    send(guest, { type: 'room:kick', targetUserId: 'u1' });
    expect(host.closeCode).toBeNull();
    send(host, { type: 'room:kick', targetUserId: 'u1' });
    expect(host.closeCode).toBeNull();
  });

  it('ban: fecha com 4002, invalida o token na hora e impede de voltar; unban libera', () => {
    const host = connect('SALA1', 'u1');
    const guest = connect('SALA1', 'u2', 'Bia');
    send(host, { type: 'room:ban', targetUserId: 'u2' });
    expect(guest.last('error')).toMatchObject({ code: 'banned' });
    expect(guest.closeCode).toBe(4002);
    expect(rm.isMember('SALA1', 'u2')).toBe(false); // token não vale mais, sem esperar a tolerância
    expect(host.last('room:bans_update').bannedMembers.map((b: any) => b.userId)).toEqual(['u2']);

    const retry = connect('SALA1', 'u2', 'Bia');
    expect(retry.last('error')).toMatchObject({ code: 'banned' });
    expect(retry.closeCode).toBe(4002);

    send(host, { type: 'room:unban', targetUserId: 'u2' });
    expect(host.last('room:bans_update').bannedMembers).toEqual([]);
    const back = connect('SALA1', 'u2', 'Bia');
    expect(back.last('room:state')).toBeTruthy();
    expect(back.closeCode).toBeNull();
  });

  it('o ban vale para a pessoa, não para a aba: abas extras (_tab) caem juntas e não voltam', () => {
    const host = connect('SALA1', 'u1');
    const first = connect('SALA1', 'u2', 'Bia');
    const second = connect('SALA1', 'u2', 'Bia'); // outra aba da mesma pessoa
    const tabId = second.last('room:state').assignedUserId as string;
    expect(tabId).toMatch(/^u2_tab\d{4}$/);

    // o Host bane pelo ID que vê na lista (o da segunda aba)
    send(host, { type: 'room:ban', targetUserId: tabId });
    expect(first.closeCode).toBe(4002);
    expect(second.closeCode).toBe(4002);
    expect(host.last('room:bans_update').bannedMembers.map((b: any) => b.userId)).toEqual(['u2']);

    // nem pelo ID-base nem por uma terceira aba
    expect(connect('SALA1', 'u2').last('error')).toMatchObject({ code: 'banned' });
    expect(rm.isMember('SALA1', tabId)).toBe(false);

    send(host, { type: 'room:unban', targetUserId: 'u2' });
    expect(connect('SALA1', 'u2').last('room:state')).toBeTruthy();
  });

  it('o Host não consegue banir a si mesmo por outra aba', () => {
    const host = connect('SALA1', 'u1');
    const hostTab = connect('SALA1', 'u1');
    const tabId = hostTab.last('room:state').assignedUserId as string;
    send(host, { type: 'room:ban', targetUserId: tabId });
    expect(host.closeCode).toBeNull();
    expect(hostTab.closeCode).toBeNull();
  });

  it('só o Host bane e desbane', () => {
    connect('SALA1', 'u1');
    const g1 = connect('SALA1', 'u2');
    const g2 = connect('SALA1', 'u3');
    send(g1, { type: 'room:ban', targetUserId: 'u3' });
    expect(g2.closeCode).toBeNull();
    expect(stateOf('SALA1').bannedMembers).toEqual([]);
  });
});

describe('sala vazia e nomes', () => {
  it('sala vazia é encerrada 30 s depois da saída da última pessoa e vira "closed"', () => {
    const host = connect('SALA1', 'u1');
    expect(rm.getRoomInfo('SALA1')).toMatchObject({ exists: true, closed: false });
    rm.handleLeave(asWs(host));
    vi.advanceTimersByTime(4000); // tolerância de reconexão
    expect(rm.getRoomInfo('SALA1').exists).toBe(true);
    vi.advanceTimersByTime(29_000);
    expect(rm.getRoomInfo('SALA1').exists).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(rm.getRoomInfo('SALA1')).toMatchObject({ exists: false, closed: true });
    expect(rm.getClosedAt('SALA1')).toBeTypeOf('number');
    expect(rm.isRoomActive('SALA1')).toBe(false);
  });

  it('entrar de novo antes dos 30 s cancela o encerramento', () => {
    const host = connect('SALA1', 'u1');
    rm.handleLeave(asWs(host));
    vi.advanceTimersByTime(4000 + 20_000);
    connect('SALA1', 'u1');
    vi.advanceTimersByTime(60_000);
    expect(rm.getRoomInfo('SALA1')).toMatchObject({ exists: true, closed: false });
  });

  it('trocar de nome é anunciado no chat e atualizado na lista', () => {
    const host = connect('SALA1', 'u1', 'Espectador #1234');
    const guest = connect('SALA1', 'u2', 'Bia');
    host.clear();
    send(guest, { type: 'user:update', username: '  Beatriz  ' });
    expect(host.of('chat:message').some((m) => m.message.text === 'Bia agora se chama Beatriz.')).toBe(true);
    expect(host.last('members:update').members.find((m: any) => m.id === 'u2').username).toBe('Beatriz');
  });

  it('chat: mensagens vazias são ignoradas e o histórico fica limitado', () => {
    const host = connect('SALA1', 'u1');
    host.clear();
    send(host, { type: 'chat:send', text: '   ' });
    expect(host.of('chat:message')).toHaveLength(0);
    for (let i = 0; i < 130; i++) send(host, { type: 'chat:send', text: `m${i}` });
    const late = connect('SALA1', 'u2');
    // quem entra depois recebe só as últimas 20 do histórico
    expect(late.of('chat:message').filter((m) => m.message.userId === 'u1')).toHaveLength(20);
  });
});
