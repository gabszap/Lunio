import { describe, expect, it, vi } from 'vitest';
import type { RoomScreen } from '../../types/screen';
import type { ScreenApi } from './api';
import type { ScreenSignals } from './signals';
import type { ScreenViewer, ViewerEvents } from './viewer';
import { ViewerScreenSession } from './viewerSession';
import type { ScreenKeyMaterial } from './wire';

const LIVE: RoomScreen = { sessionId: 's1', hostId: 'host', path: 'lunio/R/abc', quality: '1080p60', startedAt: 1, live: true };
const key = (n: number): ScreenKeyMaterial => ({ epoch: n, key: 'k' + n });

function fakeSignals(stored: ScreenKeyMaterial[] = []) {
  const keyL = new Set<(k: ScreenKeyMaterial) => void>();
  const screenL = new Set<(s: RoomScreen | null) => void>();
  const signals = {
    getScreen: () => LIVE,
    getUserId: () => 'me',
    subscribeScreen: (l: (s: RoomScreen | null) => void) => (screenL.add(l), () => screenL.delete(l)),
    subscribeScreenKey: (l: (k: ScreenKeyMaterial) => void) => {
      stored.forEach(l); // reentrega as guardadas, como o syncManager
      keyL.add(l);
      return () => keyL.delete(l);
    },
    subscribeScreenRotate: () => () => {},
    subscribeError: () => () => {},
  } as unknown as ScreenSignals;
  return {
    signals,
    pushKey: (k: ScreenKeyMaterial) => [...keyL].forEach((l) => l(k)),
    serverSets: (s: RoomScreen | null) => [...screenL].forEach((l) => l(s)),
    listeners: () => keyL.size + screenL.size,
  };
}

function fakeViewer() {
  const calls: string[] = [];
  let events!: ViewerEvents;
  const v = {
    attach: vi.fn(() => calls.push('attach')),
    addKey: vi.fn(async (k: ScreenKeyMaterial) => void calls.push('key' + k.epoch)),
    watch: vi.fn(async () => void calls.push('watch')),
    pause: vi.fn(() => calls.push('pause')),
    resume: vi.fn(() => calls.push('resume')),
    setVolume: vi.fn(),
    stop: vi.fn(() => calls.push('stop')),
  };
  return { v, calls, events: () => events, create: async (e: ViewerEvents) => (calls.push('create'), (events = e), v as unknown as ScreenViewer) };
}

function setup(stored: ScreenKeyMaterial[] = [], tokenError?: Error) {
  const sig = fakeSignals(stored);
  const fv = fakeViewer();
  const api: ScreenApi = {
    fetchToken: vi.fn(async () => {
      fv.calls.push('token');
      if (tokenError) throw tokenError;
      return { url: 'https://relay.test/SUB', path: 'lunio/R/abc', publish: false, quality: '1080p60' as const, sessionId: 's1' };
    }),
    isEnabled: async () => true,
  };
  const statuses: Array<[string, string | undefined]> = [];
  const session = new ViewerScreenSession({ signals: sig.signals, api, createViewer: fv.create }, { onStatus: (s, d) => statuses.push([s, d]) });
  const canvas = {} as HTMLCanvasElement;
  return { sig, fv, api, session, statuses, canvas };
}

describe('ViewerScreenSession.watch', () => {
  it('fetches the token, creates and attaches the viewer, loads the stored keys, then watches', async () => {
    const t = setup([key(1), key(2)]);
    t.session.attach(t.canvas);
    await t.session.watch();
    expect(t.fv.calls).toEqual(['token', 'create', 'attach', 'key1', 'key2', 'watch']);
    expect(t.fv.v.watch).toHaveBeenCalledWith({ url: 'https://relay.test/SUB', path: 'lunio/R/abc' });
    expect(t.statuses[0][0]).toBe('connecting');
  });

  it('a key that arrives later goes to the viewer', async () => {
    const t = setup();
    await t.session.watch();
    t.sig.pushKey(key(3));
    expect(t.fv.v.addKey).toHaveBeenCalledWith(key(3));
  });

  it('relays the viewer statuses (waiting counts as connecting)', async () => {
    const t = setup();
    await t.session.watch();
    t.statuses.length = 0;
    t.fv.events().onStatus('waiting');
    t.fv.events().onStatus('watching');
    expect(t.statuses.map((s) => s[0])).toEqual(['connecting', 'watching']);
  });

  it('applies the volume set before the viewer existed', async () => {
    const t = setup();
    t.session.setVolume(0.4);
    await t.session.watch();
    expect(t.fv.v.setVolume).toHaveBeenCalledWith(0.4);
    t.session.setVolume(0);
    expect(t.fv.v.setVolume).toHaveBeenLastCalledWith(0);
  });

  it('a second watch while already watching does nothing', async () => {
    const t = setup();
    await t.session.watch();
    await t.session.watch();
    expect(t.api.fetchToken).toHaveBeenCalledTimes(1);
    expect(t.fv.v.watch).toHaveBeenCalledTimes(1);
  });
});

describe('back to the video and again', () => {
  it('returnToVideo pauses; watch again resumes without a new token', async () => {
    const t = setup();
    await t.session.watch();
    t.session.returnToVideo();
    expect(t.fv.v.pause).toHaveBeenCalledTimes(1);
    t.fv.events().onStatus('paused');
    expect(t.statuses.at(-1)![0]).toBe('paused');

    await t.session.watch();
    expect(t.fv.v.resume).toHaveBeenCalledTimes(1);
    expect(t.api.fetchToken).toHaveBeenCalledTimes(1);
  });

  it('returnToVideo with nothing playing is harmless', () => {
    const t = setup();
    expect(() => t.session.returnToVideo()).not.toThrow();
  });
});

describe('endings', () => {
  it('the broadcast ending stops the viewer, releases subscriptions and reports ended', async () => {
    const t = setup();
    await t.session.watch();
    t.sig.serverSets(null);
    expect(t.fv.v.stop).toHaveBeenCalledTimes(1);
    expect(t.statuses.at(-1)![0]).toBe('ended');
    expect(t.sig.listeners()).toBe(0);
  });

  it('the viewer reporting ended (the Host closed the relay) also ends the session', async () => {
    const t = setup();
    await t.session.watch();
    t.fv.events().onStatus('ended');
    expect(t.fv.v.stop).toHaveBeenCalledTimes(1);
    expect(t.statuses.at(-1)![0]).toBe('ended');
  });

  it('dispose is idempotent and releases everything', async () => {
    const t = setup();
    await t.session.watch();
    t.session.dispose();
    t.session.dispose();
    expect(t.fv.v.stop).toHaveBeenCalledTimes(1);
    expect(t.sig.listeners()).toBe(0);
    await t.session.watch();
    expect(t.api.fetchToken).toHaveBeenCalledTimes(1);
  });

  it('dispose while the token is still being fetched never leaves a viewer running', async () => {
    const t = setup();
    const p = t.session.watch();
    t.session.dispose();
    await p;
    expect(t.fv.calls).not.toContain('watch');
    expect(t.sig.listeners()).toBe(0);
  });
});

describe('errors', () => {
  it('a token refusal (not live yet) becomes an error status with the sentence, and watch can be retried', async () => {
    const t = setup([], new Error('A transmissão ainda não começou.'));
    await t.session.watch();
    expect(t.statuses.at(-1)).toEqual(['error', 'A transmissão ainda não começou.']);
    expect(t.fv.calls).not.toContain('create');
    await t.session.watch();
    expect(t.api.fetchToken).toHaveBeenCalledTimes(2);
  });

  it('a failure to connect discards the viewer so the retry starts clean', async () => {
    const t = setup();
    t.fv.v.watch.mockRejectedValueOnce(new Error('Não foi possível conectar ao servidor de transmissão.'));
    await t.session.watch();
    expect(t.statuses.at(-1)![0]).toBe('error');
    expect(t.fv.v.stop).toHaveBeenCalledTimes(1);
    expect(t.sig.listeners()).toBe(1); // só o vigia do fim da transmissão (sem chaves penduradas)
    await t.session.watch();
    expect(t.api.fetchToken).toHaveBeenCalledTimes(2);
  });

  it('a dropped connection followed by the room ending the broadcast reads as ended, not as a stuck error', async () => {
    // O Host recarregou a página: o relay cai (erro de transporte) antes do aviso do servidor chegar
    const t = setup();
    await t.session.watch();
    t.fv.events().onStatus('error', 'A conexão com a transmissão caiu.');
    expect(t.statuses.at(-1)![0]).toBe('error');
    t.sig.serverSets(null);
    expect(t.statuses.at(-1)![0]).toBe('ended');
    expect(t.sig.listeners()).toBe(0);
  });

  it('the viewer dropping the connection reports error and allows a retry', async () => {
    const t = setup();
    await t.session.watch();
    t.fv.events().onStatus('error', 'A conexão com a transmissão caiu.');
    expect(t.statuses.at(-1)).toEqual(['error', 'A conexão com a transmissão caiu.']);
    expect(t.fv.v.stop).toHaveBeenCalledTimes(1);
  });
});
