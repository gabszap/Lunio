import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomState, ServerMessage } from '../../types/sync';

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWS[] = [];

  readyState = FakeWS.CONNECTING;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((err: any) => void) | null = null;

  constructor(public readonly url: string) {
    FakeWS.instances.push(this);
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.readyState = FakeWS.CLOSED;
  }

  open() {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }

  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(code = 1006) {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.({ code });
  }
}

function makeRoomState(hostId: string, overrides: Partial<RoomState> = {}): RoomState {
  return {
    roomId: 'ABCD1234',
    hostId,
    name: 'Cinema',
    visibility: 'private',
    hasPassword: true,
    locked: false,
    autoPauseOnBuffer: false,
    media: null,
    playback: { playing: false, position: 0, rate: 1, updatedAt: Date.now() },
    members: [
      {
        id: hostId,
        username: 'Host',
        isHost: true,
        ready: true,
        state: 'ready',
        currentTime: 0,
        ping: 0,
      },
    ],
    ...overrides,
  };
}

describe('syncManager room initialSettings & locked', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal('window', {
      parent: undefined,
      location: { protocol: 'http:', host: 'localhost:3000', hostname: 'localhost', href: 'http://localhost:3000/', pathname: '/', search: '' },
      history: { replaceState: vi.fn() },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('envia initialSettings no primeiro room:join e não reenvia em reconexões após room:state', async () => {
    const { syncManager } = await import('../sync');
    const initialSettings = { name: 'Cinema', visibility: 'private' as const, password: '123' };

    syncManager.connect('ABCD1234', undefined, initialSettings);
    expect(FakeWS.instances).toHaveLength(1);
    const first = FakeWS.instances[0];
    first.open();

    const firstJoin = first.sent.find((m) => m.type === 'room:join');
    expect(firstJoin).toMatchObject({
      type: 'room:join',
      roomId: 'ABCD1234',
      initialSettings: { name: 'Cinema', visibility: 'private', password: '123' },
    });

    first.receive({
      type: 'room:state',
      state: makeRoomState(syncManager.getUser().id),
    });

    // Desconexão e reconexão automática não devem reenviar initialSettings nem senha em texto plano
    first.drop();
    vi.advanceTimersByTime(1000);
    expect(FakeWS.instances).toHaveLength(2);
    const second = FakeWS.instances[1];
    second.open();

    const reconnectJoin = second.sent.find((m) => m.type === 'room:join');
    expect(reconnectJoin).toMatchObject({
      type: 'room:join',
      roomId: 'ABCD1234',
    });
    expect(reconnectJoin.initialSettings).toBeUndefined();
    expect('initialSettings' in reconnectJoin).toBe(false);
    expect(reconnectJoin.password).toBeUndefined();

    syncManager.leaveRoom();
  });

  it('limpa initialSettings pendente ao trocar de sala sem ele ou ao sair da sala', async () => {
    const { syncManager } = await import('../sync');

    syncManager.connect('ROOM1', undefined, { name: 'Privada', visibility: 'private', password: 'abc' });
    // Antes de abrir, troca para outra sala sem initialSettings
    syncManager.joinRoom('ROOM2');
    const ws = FakeWS.instances[0];
    ws.open();

    const joinMsg = ws.sent.find((m) => m.type === 'room:join');
    expect(joinMsg).toMatchObject({ type: 'room:join', roomId: 'ROOM2' });
    expect(joinMsg.initialSettings).toBeUndefined();

    // Também suporta joinRoom com initialSettings quando já conectado
    syncManager.joinRoom('ROOM3', undefined, { name: 'Nova', visibility: 'public' });
    const join3 = ws.sent.filter((m) => m.type === 'room:join').at(-1);
    expect(join3).toMatchObject({
      type: 'room:join',
      roomId: 'ROOM3',
      initialSettings: { name: 'Nova', visibility: 'public' },
    });

    syncManager.leaveRoom();
  });

  it('atualiza roomState.locked ao receber room:settings_update e envia locked em emitRoomSettings', async () => {
    const { syncManager } = await import('../sync');
    syncManager.connect('ABCD1234');
    const ws = FakeWS.instances[0];
    ws.open();

    const myId = syncManager.getUser().id;
    ws.receive({
      type: 'room:state',
      state: makeRoomState(myId, { locked: false }),
    });
    expect(syncManager.getRoomState()?.locked).toBe(false);

    syncManager.emitRoomSettings({ locked: true });
    const settingsMsg = ws.sent.find((m) => m.type === 'room:settings');
    expect(settingsMsg).toEqual({ type: 'room:settings', locked: true });

    ws.receive({
      type: 'room:settings_update',
      name: 'Cinema',
      visibility: 'private',
      hasPassword: true,
      locked: true,
      autoPauseOnBuffer: false,
    });
    expect(syncManager.getRoomState()?.locked).toBe(true);

    syncManager.leaveRoom();
  });
});
