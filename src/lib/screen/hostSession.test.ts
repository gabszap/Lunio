import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screenQuality, type RoomScreen } from '../../types/screen';
import { HostScreenSession } from './hostSession';
import type { ScreenApi } from './api';
import type { PublisherEvents, ScreenPublisher } from './publisher';
import type { ScreenSignals } from './signals';
import type { ScreenKeyMaterial } from './wire';

const ME = 'usr_me';
const QUALITY = screenQuality('1080p60')!;
const SCREEN: RoomScreen = { sessionId: 's1', hostId: ME, path: 'lunio/R/abc', quality: '1080p60', startedAt: 1, live: false };

/** Sala falsa: registra a ordem de tudo o que a sessão emite e deixa o teste responder pelo servidor. */
function fakeSignals() {
  const calls: string[] = [];
  let screen: RoomScreen | null = null;
  const screenL = new Set<(s: RoomScreen | null) => void>();
  const rotateL = new Set<() => void>();
  const errorL = new Set<(m: string, c?: string) => void>();
  const emitted: Array<{ type: string; [k: string]: unknown }> = [];
  const signals: ScreenSignals = {
    getScreen: () => screen,
    getUserId: () => ME,
    subscribeScreen: (l) => (screenL.add(l), () => screenL.delete(l)),
    subscribeScreenKey: () => () => {},
    subscribeScreenRotate: (l) => (rotateL.add(l), () => rotateL.delete(l)),
    subscribeError: (l) => (errorL.add(l), () => errorL.delete(l)),
    emitScreenStart: (q) => (calls.push('start'), emitted.push({ type: 'start', q })),
    emitScreenLive: () => (calls.push('live'), emitted.push({ type: 'live' })),
    emitScreenStop: () => (calls.push('stop'), emitted.push({ type: 'stop' })),
    emitScreenKey: (k) => (calls.push('key'), emitted.push({ type: 'key', ...k })),
    emitScreenUsage: (b) => (calls.push('usage'), emitted.push({ type: 'usage', b })),
    emitScreenWatching: () => {},
  };
  return {
    signals,
    calls,
    emitted,
    serverSets(s: RoomScreen | null) {
      screen = s;
      [...screenL].forEach((l) => l(s));
    },
    serverRotate: () => [...rotateL].forEach((l) => l()),
    serverError: (m: string, c: string) => [...errorL].forEach((l) => l(m, c)),
    listeners: () => screenL.size + rotateL.size + errorL.size,
  };
}

function fakePublisher(opts: { startError?: Error; startGate?: Promise<void> } = {}) {
  let events!: PublisherEvents;
  const pub = {
    start: vi.fn(async (o: { initialKey: ScreenKeyMaterial }) => {
      pub.initialKey = o.initialKey;
      await opts.startGate;
      if (opts.startError) throw opts.startError;
    }),
    rotateKey: vi.fn(async () => ({ epoch: ++pub.epoch, key: 'k' + pub.epoch })),
    stop: vi.fn(async () => {}),
    stats: { hasSubscribers: true },
    epoch: 1,
    initialKey: null as ScreenKeyMaterial | null,
  };
  return { pub, events: () => events, create: async (e: PublisherEvents) => ((events = e), pub as unknown as ScreenPublisher) };
}

const TOKEN = { url: 'https://relay.test/PUB', path: 'lunio/R/abc', publish: true, quality: '1080p60' as const, sessionId: 's1' };

function setup(pubOpts: Parameters<typeof fakePublisher>[0] = {}, tokenResult: Promise<typeof TOKEN> | typeof TOKEN = TOKEN) {
  const sig = fakeSignals();
  const p = fakePublisher(pubOpts);
  const api: ScreenApi = { fetchToken: vi.fn(async () => (sig.calls.push('token'), tokenResult)), isEnabled: async () => true };
  const statuses: Array<[string, string | undefined]> = [];
  const session = new HostScreenSession(
    { signals: sig.signals, api, createPublisher: (e) => (sig.calls.push('create'), p.create(e)) },
    { onStatus: (s, d) => statuses.push([s, d]) },
  );
  return { sig, p, api, session, statuses };
}

/** Faz o "servidor" confirmar a transmissão assim que `screen:start` sai. */
async function confirmed(t: ReturnType<typeof setup>) {
  const startPromise = t.session.start(QUALITY);
  await vi.advanceTimersByTimeAsync(0);
  t.sig.serverSets(SCREEN);
  return startPromise;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('HostScreenSession.start', () => {
  it('follows the order that keeps the user gesture alive: start, token, picker, key, live', async () => {
    const t = setup();
    expect(await confirmed(t)).toBe('started');
    expect(t.sig.calls).toEqual(['start', 'token', 'create', 'key', 'live']);
    const key = t.sig.emitted.find((e) => e.type === 'key')!;
    expect(key).toMatchObject({ epoch: 1, key: t.p.pub.initialKey!.key });
    expect(t.sig.emitted[0]).toEqual({ type: 'start', q: '1080p60' });
    expect(t.statuses.map((s) => s[0])).toEqual(['starting', 'live']);
  });

  it('a cancelled picker sends screen:stop, ends idle and is not an error', async () => {
    const err = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    const t = setup({ startError: err });
    expect(await confirmed(t)).toBe('cancelled');
    expect(t.sig.calls.at(-1)).toBe('stop');
    expect(t.statuses.map((s) => s[0])).toEqual(['starting', 'idle']);
    expect(t.statuses.some((s) => s[0] === 'error')).toBe(false);
  });

  it('any other start failure sends screen:stop and rethrows with an error status', async () => {
    const t = setup({ startError: new Error('sem relay') });
    await expect(confirmed(t)).rejects.toThrow('sem relay');
    expect(t.sig.calls.at(-1)).toBe('stop');
    expect(t.statuses.at(-1)![0]).toBe('error');
  });

  it('the server refusing (busy) rejects with the translated sentence, without token or stop', async () => {
    const t = setup();
    const p = t.session.start(QUALITY);
    const caught = p.catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(0);
    t.sig.serverError('cheio', 'screen_busy');
    const err = (await caught) as Error;
    expect(err.message).toMatch(/transmiss|broadcast/i);
    expect(t.sig.calls).toEqual(['start']);
    expect(t.statuses.at(-1)![0]).toBe('error');
  });

  it('the server never confirming times out in 5 s and cleans up with screen:stop', async () => {
    const t = setup();
    const caught = t.session.start(QUALITY).catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(5200);
    expect(((await caught) as Error).message).toBeTruthy();
    expect(t.sig.calls).toEqual(['start', 'stop']);
    expect(t.sig.listeners()).toBe(0);
  });

  it('a token that is not a publish token is refused before the picker opens', async () => {
    const t = setup({}, { ...TOKEN, publish: false });
    await expect(confirmed(t)).rejects.toThrow();
    expect(t.sig.calls).not.toContain('create');
    expect(t.sig.calls.at(-1)).toBe('stop');
  });
});

describe('HostScreenSession while live', () => {
  async function live() {
    const t = setup();
    await confirmed(t);
    t.sig.emitted.length = 0;
    t.sig.calls.length = 0;
    return t;
  }

  it('answers screen:rotate_key with the next key, in order', async () => {
    const t = await live();
    t.sig.serverRotate();
    t.sig.serverRotate();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sig.emitted.filter((e) => e.type === 'key').map((e) => e.epoch)).toEqual([2, 3]);
  });

  it('reports the publisher usage to the room', async () => {
    const t = await live();
    t.p.events().onUsage(1234);
    expect(t.sig.emitted).toEqual([{ type: 'usage', b: 1234 }]);
  });

  it('the user stopping the capture sends screen:stop once and goes idle', async () => {
    const t = await live();
    t.p.events().onEnded('user');
    t.p.events().onEnded('user');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sig.calls.filter((c) => c === 'stop')).toHaveLength(1);
    expect(t.statuses.at(-1)![0]).toBe('idle');
    expect(t.sig.listeners()).toBe(0);
  });

  it('a publisher error goes to the error status with the detail', async () => {
    const t = await live();
    t.p.events().onEnded('error', 'codificador caiu');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.statuses.at(-1)).toEqual(['error', 'codificador caiu']);
    expect(t.sig.calls).toContain('stop');
  });

  it('the server ending the broadcast, or giving it to someone else, stops the publisher without screen:stop', async () => {
    for (const next of [null, { ...SCREEN, hostId: 'usr_other' }]) {
      const t = await live();
      t.sig.serverSets(next);
      await vi.advanceTimersByTimeAsync(0);
      expect(t.p.pub.stop).toHaveBeenCalledTimes(1);
      expect(t.sig.calls).not.toContain('stop');
      expect(t.statuses.at(-1)![0]).toBe('idle');
    }
  });

  it('my own broadcast updating (live: true) does not stop anything', async () => {
    const t = await live();
    t.sig.serverSets({ ...SCREEN, live: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.p.pub.stop).not.toHaveBeenCalled();
  });

  it('stop() is idempotent and releases every subscription', async () => {
    const t = await live();
    await t.session.stop();
    await t.session.stop();
    expect(t.sig.calls.filter((c) => c === 'stop')).toHaveLength(1);
    expect(t.p.pub.stop).toHaveBeenCalledTimes(1);
    expect(t.sig.listeners()).toBe(0);
    t.sig.serverRotate();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.p.pub.rotateKey).not.toHaveBeenCalled();
  });

  it('exposes whether anyone is watching', async () => {
    const t = await live();
    expect(t.session.hasSubscribers).toBe(true);
  });
});

describe('HostScreenSession when the server ended the broadcast during the picker', () => {
  it('does not announce a live broadcast the room no longer has: stops the publisher and cancels', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({ startGate: gate });
    const starting = t.session.start(QUALITY);
    await vi.advanceTimersByTimeAsync(0);
    t.sig.serverSets(SCREEN); // confirmou
    await vi.advanceTimersByTimeAsync(0);
    t.sig.serverSets(null); // acabou (ex.: um stop de órfã vindo de outra aba) enquanto o seletor está aberto
    release();
    expect(await starting).toBe('cancelled');
    expect(t.sig.calls).not.toContain('live');
    expect(t.sig.calls).not.toContain('key');
    expect(t.p.pub.stop).toHaveBeenCalled();
    expect(t.statuses.at(-1)![0]).toBe('idle');
    expect(t.sig.listeners()).toBe(0);
  });
});

describe('HostScreenSession.stop during start', () => {
  it('stopping while the picker is open cancels cleanly and leaves no live publisher', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({ startGate: gate });
    const starting = t.session.start(QUALITY);
    await vi.advanceTimersByTimeAsync(0);
    t.sig.serverSets(SCREEN);
    await vi.advanceTimersByTimeAsync(0);
    await t.session.stop();
    release();
    expect(await starting).toBe('cancelled');
    expect(t.p.pub.stop).toHaveBeenCalled();
    expect(t.sig.calls).not.toContain('live');
    expect(t.sig.calls.filter((c) => c === 'stop')).toHaveLength(1);
    expect(t.sig.listeners()).toBe(0);
  });
});
