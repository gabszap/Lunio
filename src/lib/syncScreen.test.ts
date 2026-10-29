import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** WebSocket falso: o teste decide quando abre e entrega as mensagens do servidor. */
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
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  sentTypes() {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const SCREEN = { sessionId: 'abcd', hostId: 'host', path: 'lunio/SALA/xyz', quality: '1080p60', startedAt: 1, live: true };
const KEY = (n: number) => ({ epoch: n, key: Buffer.alloc(32, n).toString('base64') });

function roomState(screen: object | null = null) {
  return {
    type: 'room:state',
    state: {
      roomId: 'SALA',
      hostId: 'host',
      media: null,
      playback: { playing: false, position: 0, rate: 1, updatedAt: 0 },
      members: [{ id: 'host', username: 'host', isHost: true, ready: true, state: 'ready', currentTime: 0 }],
      screen,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', { parent: undefined, location: { protocol: 'https:', host: 'lunio.test', hostname: 'lunio.test', search: '' }, addEventListener: () => {}, removeEventListener: () => {} });
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connected(screen: object | null = null) {
  const { syncManager } = await import('./sync');
  syncManager.connect('SALA');
  FakeWebSocket.last.open();
  FakeWebSocket.last.deliver(roomState(screen));
  return { syncManager, ws: FakeWebSocket.last };
}

describe('screen state', () => {
  it('screen:state updates getScreen and notifies, null clears', async () => {
    const { syncManager, ws } = await connected();
    const seen: unknown[] = [];
    syncManager.subscribeScreen((s) => seen.push(s));
    expect(syncManager.getScreen()).toBeNull();

    ws.deliver({ type: 'screen:state', screen: SCREEN });
    expect(syncManager.getScreen()).toEqual(SCREEN);
    ws.deliver({ type: 'screen:state', screen: null });
    expect(syncManager.getScreen()).toBeNull();
    expect(seen).toEqual([SCREEN, null]);
  });

  it('a room:state that already carries a broadcast exposes it', async () => {
    const { syncManager } = await connected(SCREEN);
    expect(syncManager.getScreen()).toEqual(SCREEN);
  });

  it('screen:state also reaches the general state listeners', async () => {
    const { syncManager, ws } = await connected();
    const states: unknown[] = [];
    syncManager.subscribeState((s) => states.push(s?.screen ?? null));
    ws.deliver({ type: 'screen:state', screen: SCREEN });
    expect(states.at(-1)).toEqual(SCREEN);
  });
});

describe('screen keys', () => {
  it('relays a key to subscribers and replays the stored ones, in epoch order, to a late subscriber', async () => {
    const { syncManager, ws } = await connected(SCREEN);
    const early: number[] = [];
    syncManager.subscribeScreenKey((k) => early.push(k.epoch));
    ws.deliver({ type: 'screen:key', ...KEY(1) });
    ws.deliver({ type: 'screen:key', ...KEY(2) });
    expect(early).toEqual([1, 2]);

    const late: number[] = [];
    syncManager.subscribeScreenKey((k) => late.push(k.epoch));
    expect(late).toEqual([1, 2]);
  });

  it('keeps only the four newest epochs and ignores repeats and malformed keys', async () => {
    const { syncManager, ws } = await connected(SCREEN);
    for (const n of [1, 2, 3, 4, 5, 3]) ws.deliver({ type: 'screen:key', ...KEY(n) });
    ws.deliver({ type: 'screen:key', epoch: 9 });
    ws.deliver({ type: 'screen:key', epoch: 'x', key: 'y' });
    const got: number[] = [];
    syncManager.subscribeScreenKey((k) => got.push(k.epoch));
    expect(got).toEqual([2, 3, 4, 5]);
  });

  it('forgets the keys when the broadcast ends, when a fresh room:state has none, and when leaving the room', async () => {
    const { syncManager, ws } = await connected(SCREEN);
    ws.deliver({ type: 'screen:key', ...KEY(1) });
    ws.deliver({ type: 'screen:state', screen: null });
    let got: number[] = [];
    syncManager.subscribeScreenKey((k) => got.push(k.epoch));
    expect(got).toEqual([]);

    ws.deliver({ type: 'screen:state', screen: SCREEN });
    ws.deliver({ type: 'screen:key', ...KEY(2) });
    ws.deliver(roomState(null));
    got = [];
    syncManager.subscribeScreenKey((k) => got.push(k.epoch));
    expect(got).toEqual([]);

    ws.deliver({ type: 'screen:state', screen: SCREEN });
    ws.deliver({ type: 'screen:key', ...KEY(3) });
    syncManager.leaveRoom();
    got = [];
    syncManager.subscribeScreenKey((k) => got.push(k.epoch));
    expect(got).toEqual([]);
  });

  it('forgets them when kicked or banned', async () => {
    const { syncManager, ws } = await connected(SCREEN);
    ws.deliver({ type: 'screen:key', ...KEY(1) });
    ws.deliver({ type: 'error', message: 'x', code: 'kicked' });
    const got: number[] = [];
    syncManager.subscribeScreenKey((k) => got.push(k.epoch));
    expect(got).toEqual([]);
  });

  it('screen:rotate_key calls the rotation subscribers; unsubscribing stops it', async () => {
    const { syncManager, ws } = await connected(SCREEN);
    const rotate = vi.fn();
    const off = syncManager.subscribeScreenRotate(rotate);
    ws.deliver({ type: 'screen:rotate_key' });
    expect(rotate).toHaveBeenCalledTimes(1);
    off();
    ws.deliver({ type: 'screen:rotate_key' });
    expect(rotate).toHaveBeenCalledTimes(1);
  });
});

describe('screen emitters', () => {
  it('send the right messages', async () => {
    const { syncManager, ws } = await connected();
    syncManager.emitScreenStart('720p60');
    syncManager.emitScreenKey(KEY(1));
    syncManager.emitScreenLive();
    syncManager.emitScreenUsage(1234);
    syncManager.emitScreenStop();
    expect(ws.sentTypes().filter((m) => String(m.type).startsWith('screen:'))).toEqual([
      { type: 'screen:start', quality: '720p60' },
      { type: 'screen:key', ...KEY(1) },
      { type: 'screen:live' },
      { type: 'screen:usage', bytes: 1234 },
      { type: 'screen:stop' },
    ]);
  });

  it('do not throw without a connection, and getUserId is the local id', async () => {
    const { syncManager } = await import('./sync');
    expect(() => syncManager.emitScreenStop()).not.toThrow();
    expect(syncManager.getUserId()).toBe(syncManager.getUser().id);
  });

  it('forwards server errors to subscribeError', async () => {
    const { syncManager, ws } = await connected();
    const errors: Array<[string, string | undefined]> = [];
    syncManager.subscribeError((m, c) => errors.push([m, c]));
    ws.deliver({ type: 'error', message: 'cheio', code: 'screen_busy' });
    expect(errors).toEqual([['cheio', 'screen_busy']]);
  });
});
