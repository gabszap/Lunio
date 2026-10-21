import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RoomManager } from '../roomServer';

vi.mock('../media/resolver', () => ({ warmUpMedia: vi.fn() }));

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
const connect = (roomId: string, id: string) => {
  const s = new FakeSocket();
  rm.handleClientMessage(asWs(s), JSON.stringify({ type: 'room:join', roomId, user: { id, username: id } }));
  return s;
};
const send = (s: FakeSocket, msg: object) => rm.handleClientMessage(asWs(s), JSON.stringify(msg));
const vote = (s: FakeSocket, start = 10, target = 90, v = true) => send(s, { type: 'skip:vote', start, target, vote: v });

const CHAPTERS = [
  { startTime: 0, endTime: 10, title: 'Intro' },
  { startTime: 10, endTime: 90, title: 'OP' },
  { startTime: 90, endTime: 1300, title: 'Episódio' },
];

/** Sala com Host e `guests` espectadores, com o vídeo carregado (e capítulos). */
function room(guests: number, roomId = 'SKIP') {
  const host = connect(roomId, 'host');
  send(host, { type: 'media:set', media: { url: 'https://exemplo.test/a.mkv', title: 'Ep', duration: 1400, chapters: CHAPTERS }, initialPosition: 20 });
  const viewers = Array.from({ length: guests }, (_, i) => connect(roomId, `g${i + 1}`));
  for (const s of [host, ...viewers]) s.clear();
  return { host, viewers };
}

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

describe('voto para pular abertura/encerramento', () => {
  it('cada voto mostra quantos faltam; ao passar da metade o Host recebe o pedido de pular', () => {
    const { host, viewers: [a, b] } = room(2); // 3 pessoas: precisa de 2
    vote(a);
    expect(host.last('skip:votes').skip).toMatchObject({ start: 10, target: 90, votes: 1, needed: 2, voters: ['g1'] });
    expect(b.last('skip:votes').skip.votes).toBe(1);
    expect(host.of('skip:passed')).toHaveLength(0);

    vote(b);
    expect(host.last('skip:passed')).toEqual({ type: 'skip:passed', start: 10, target: 90 });
    // só o Host recebe o pedido (o seek é dele) e a votação zera para todos
    expect(a.of('skip:passed')).toHaveLength(0);
    expect(b.of('skip:passed')).toHaveLength(0);
    expect(a.last('skip:votes').skip).toBeNull();
  });

  it('com 2 pessoas o voto do espectador não basta: o Host decide', () => {
    const { host, viewers: [a] } = room(1); // 2 pessoas: precisa de 2
    vote(a);
    expect(host.last('skip:votes').skip).toMatchObject({ votes: 1, needed: 2 });
    expect(host.of('skip:passed')).toHaveLength(0);
  });

  it('o voto do Host é ignorado (ele pula direto pelo botão)', () => {
    const { host, viewers: [a] } = room(2);
    vote(host);
    expect(a.of('skip:votes')).toHaveLength(0);
  });

  it('retirar o voto desfaz; a votação some quando ninguém mais vota', () => {
    const { host, viewers: [a, b] } = room(2);
    vote(a);
    vote(a, 10, 90, false);
    expect(host.last('skip:votes').skip).toBeNull();
    vote(b);
    expect(host.last('skip:votes').skip.voters).toEqual(['g2']);
  });

  it('voto para um trecho que não é capítulo da mídia (destino forjado) é ignorado', () => {
    const { host, viewers: [a, b] } = room(2);
    vote(a, 10, 1200); // o destino não bate com o capítulo
    vote(b, 500, 600);
    vote(a, Number.NaN, 90);
    expect(host.of('skip:votes')).toHaveLength(0);
    expect(host.of('skip:passed')).toHaveLength(0);
  });

  it('quem sai tem o voto retirado; se saem não votantes a conta fecha e passa', () => {
    const { host, viewers: [a, b, c, d] } = room(4); // 5 pessoas: precisa de 3
    vote(a);
    vote(b);
    expect(host.last('skip:votes').skip).toMatchObject({ votes: 2, needed: 3 });
    // c sai (não votou): ficam 4, precisa de 3 e há 2; d sai: ficam 3, precisa de 2 e há 2 votos -> passa
    rm.handleLeave(asWs(c));
    vi.advanceTimersByTime(4500);
    expect(host.of('skip:passed')).toHaveLength(0);
    rm.handleLeave(asWs(d));
    vi.advanceTimersByTime(4500);
    expect(host.last('skip:passed')).toMatchObject({ start: 10, target: 90 });
  });

  it('quem entra no meio da votação a vê', () => {
    const { viewers: [a] } = room(3);
    vote(a);
    const late = connect('SKIP', 'tarde');
    expect(late.last('skip:votes').skip).toMatchObject({ votes: 1, voters: ['g1'] });
  });

  it('trocar de vídeo encerra a votação', () => {
    const { host, viewers: [a] } = room(3);
    vote(a);
    send(host, { type: 'media:set', media: { url: 'https://exemplo.test/b.mkv', title: 'Ep 2', duration: 1400, chapters: CHAPTERS }, initialPosition: 0 });
    expect(a.last('skip:votes').skip).toBeNull();
  });

  it('o Host levar o vídeo para fora do capítulo encerra a votação; dentro dele, não', () => {
    const { host, viewers: [a] } = room(3);
    vote(a);
    send(host, { type: 'playback:seek', position: 40 }); // ainda dentro da abertura
    expect(a.last('skip:votes').skip).not.toBeNull();
    send(host, { type: 'playback:seek', position: 95 }); // passou do fim
    expect(a.last('skip:votes').skip).toBeNull();
  });

  describe('capítulos informados pelo Host (media:chapters)', () => {
    /** Sala cujo vídeo foi definido SEM capítulos, como no uso real (eles só são lidos depois pelo player do Host). */
    function roomWithoutChapters() {
      const host = connect('CAPS', 'host');
      send(host, { type: 'media:set', media: { url: 'https://exemplo.test/a.mkv', title: 'Ep', duration: 1400 }, initialPosition: 20 });
      const viewers = [connect('CAPS', 'g1'), connect('CAPS', 'g2')];
      return { host, viewers };
    }

    it('sem capítulos na lista o voto não vale; depois que o Host os informa, vale', () => {
      const { host, viewers: [a] } = roomWithoutChapters();
      vote(a);
      expect(host.of('skip:votes')).toHaveLength(0);
      send(host, { type: 'media:chapters', url: 'https://exemplo.test/a.mkv', chapters: CHAPTERS });
      vote(a);
      expect(host.last('skip:votes').skip).toMatchObject({ start: 10, target: 90, votes: 1 });
    });

    it('só o Host informa capítulos, e só os do vídeo atual', () => {
      const { host, viewers: [a, b] } = roomWithoutChapters();
      send(a, { type: 'media:chapters', url: 'https://exemplo.test/a.mkv', chapters: CHAPTERS }); // espectador: ignorado
      send(host, { type: 'media:chapters', url: 'https://exemplo.test/outro.mkv', chapters: CHAPTERS }); // vídeo que não é o atual
      vote(b);
      expect(host.of('skip:votes')).toHaveLength(0);
    });

    it('descarta capítulos com números inválidos', () => {
      const { host, viewers: [a] } = roomWithoutChapters();
      send(host, { type: 'media:chapters', url: 'https://exemplo.test/a.mkv', chapters: [{ startTime: 'x', endTime: 90, title: 'OP' }, { startTime: 10, endTime: 90, title: 'OP' }] });
      vote(a);
      expect(host.last('skip:votes').skip.start).toBe(10);
    });
  });
});
