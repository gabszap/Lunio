import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomState, ServerMessage } from '../types/sync';

/** WebSocket falso: o teste decide quando abre e quando cai. */
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static last: FakeWebSocket;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor() {
    FakeWebSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', { parent: undefined, location: { protocol: 'https:', host: 'lunio.test', hostname: 'lunio.test', search: '' }, addEventListener: () => {}, removeEventListener: () => {} });
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function receivePlayback(socket: FakeWebSocket, playback: RoomState['playback']) {
  socket.receive({
    type: 'room:state',
    state: { roomId: 'SALA', media: null, hostId: 'host', members: [], playback },
  });
}

describe('aviso de reconexão', () => {
  it('só marca "reconectando" quando a conexão com a sala cai; kick/ban e sair não', async () => {
    const { syncManager } = await import('./sync');
    expect(syncManager.getStatus().reconnecting).toBe(false);

    syncManager.connect('SALA');
    FakeWebSocket.last.open();
    expect(syncManager.getStatus().reconnecting).toBe(false);

    FakeWebSocket.last.drop(); // restart do servidor
    expect(syncManager.getStatus().reconnecting).toBe(true);

    vi.advanceTimersByTime(2000); // tentativa seguinte
    FakeWebSocket.last.open();
    expect(syncManager.getStatus().reconnecting).toBe(false);

    FakeWebSocket.last.drop(4002); // banido: não tenta voltar
    expect(syncManager.getStatus().reconnecting).toBe(false);
  });

  it('usa backoff, volta à sala e usa a posição nova com o relógio reiniciado', async () => {
    const { syncManager } = await import('./sync');
    syncManager.connect('SALA');
    const first = FakeWebSocket.last;
    first.open();
    receivePlayback(first, { playing: true, position: 10, rate: 1, updatedAt: Date.now() });
    const beat = first.sent.map((data) => JSON.parse(data)).find((msg) => msg.type === 'client:heartbeat');
    expect(beat).not.toHaveProperty('state');
    first.receive({ type: 'server:heartbeat_ack', clientTime: beat.clientTime, serverTime: Date.now() + 90_000 });
    expect(syncManager.getExpectedPosition()).toBeCloseTo(100, 1);

    first.drop();
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.last).toBe(first);
    vi.advanceTimersByTime(1);
    const failedRetry = FakeWebSocket.last;
    expect(failedRetry).not.toBe(first);
    failedRetry.drop();
    vi.advanceTimersByTime(1499);
    expect(FakeWebSocket.last).toBe(failedRetry);
    vi.advanceTimersByTime(1);
    const next = FakeWebSocket.last;
    expect(next).not.toBe(failedRetry);
    next.open();
    expect(JSON.parse(next.sent[0])).toMatchObject({ type: 'room:join', roomId: 'SALA' });
    receivePlayback(next, { playing: true, position: 40, rate: 1.5, updatedAt: Date.now() });
    expect(syncManager.getExpectedPosition()).toBe(40);
    vi.advanceTimersByTime(2000);
    expect(syncManager.getExpectedPosition()).toBe(43);
  });
});

it('espera o estado da sala ao reconectar ou receber uma geração nova para a mesma URL', async () => {
  const { syncManager } = await import('./sync');
  const source = 'https://cdn.test/episodio.mp4';
  const media = { url: source, generation: 1, title: 'Episódio', duration: 100 };
  const room: RoomState = {
    roomId: 'SALA', hostId: 'host', members: [], media,
    playback: { playing: true, position: 50, rate: 1.5, updatedAt: Date.now() },
  };

  syncManager.connect('SALA');
  const first = FakeWebSocket.last;
  first.open();
  first.receive({ type: 'room:state', state: room });
  const original = syncManager.getConfirmedPlayback(source);
  expect(original).toEqual({ generation: 1 });

  const nextMedia = { ...media, generation: 2 };
  first.receive({ type: 'media:sync', media: nextMedia, generation: 2, triggeredBy: 'host', username: 'Host' });
  expect(syncManager.getConfirmedPlayback(source)).toBeNull();

  const newState = { ...room, media: nextMedia, playback: { ...room.playback, playing: false, position: 0 } };
  first.receive({ type: 'room:state', state: newState });
  const next = syncManager.getConfirmedPlayback(source);
  expect(next).toEqual({ generation: 2 });
  first.receive({ type: 'media:sync', media, generation: 1, triggeredBy: 'host', username: 'Host' });
  expect(syncManager.getConfirmedPlayback(source)).toBe(next);

  first.drop();
  vi.advanceTimersByTime(1000);
  const reconnected = FakeWebSocket.last;
  reconnected.open();
  expect(syncManager.getConfirmedPlayback(source)).toBeNull();
  reconnected.receive({ type: 'room:state', state: newState });
  expect(syncManager.getConfirmedPlayback(source)).toEqual({ generation: 2 });
  expect(syncManager.getConfirmedPlayback(source)).not.toBe(next);
});

describe('correção de drift do espectador', () => {
  it.each([
    [100.51, 'seek'], [100.49, 'rate_slowdown'], [100.13, 'rate_slowdown'], [100.11, 'none'],
    [99.76, 'none'], [99.74, 'rate_speedup'], [98.81, 'rate_speedup'], [98.79, 'seek'],
  ])('classifica a posição %s em %s quando o Host está em 100 s', async (position, action) => {
    const { syncManager } = await import('./sync');
    syncManager.connect('SALA');
    FakeWebSocket.last.open();
    receivePlayback(FakeWebSocket.last, { playing: false, position: 100, rate: 1.5, updatedAt: Date.now() });
    expect(syncManager.calculateDrift(position)).toMatchObject({ action, targetTime: 100 });
  });
});
