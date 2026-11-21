import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.SESSION_SECRET = 'segredo-de-teste';
const state = vi.hoisted(() => ({ dir: '', originCalls: 0 }));
vi.mock('../media/paths', async importOriginal => ({ ...await importOriginal<object>(), get SUB_CACHE_DIR() { return state.dir; } }));
vi.mock('../media/resolver', () => ({ resolveFinalCdnUrl: () => { state.originCalls++; throw new Error('Status must not resolve origin'); } }));

const { createApiRouter } = await import('../app');
const { startApi, FakeSocket, asWs } = await import('./helpers');
const { roomManager } = await import('../roomServer');
const { issueRoomToken } = await import('../access');
const { getMediaFingerprint } = await import('../media/fingerprint');
const { subtitleProgress } = await import('../media/subtitleProgress');
const { writeCachedSubtitle } = await import('../media/subtitleCache');

describe('GET /api/subtitle status observation', () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  let soloToken: string;
  let guestId: string;
  const secretUrl = 'https://cdn.test/private/video.mkv?token=SECRET';
  const ask = (token: string | undefined, url = secretUrl, track = '3', extra = '') => fetch(`${api.base}/api/subtitle?status=1&url=${encodeURIComponent(url)}&track=${track}${extra}`, { headers: token ? { 'X-Lunio-Token': token } : {} });
  beforeAll(async () => {
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-status-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api = await startApi(createApiRouter);
    soloToken = ((await (await fetch(`${api.base}/api/session`, { method: 'POST' })).json()) as { token: string }).token;
    const join = (roomId: string, id: string) => {
      const socket = new FakeSocket();
      roomManager.handleClientMessage(asWs(socket), JSON.stringify({ type: 'room:join', roomId, user: { id, username: id } }));
      return socket;
    };
    const host = join('SUBS1', 'host');
    join('SUBS2', 'other');
    roomManager.handleClientMessage(asWs(host), JSON.stringify({ type: 'media:set', media: { url: secretUrl, title: 'Ep', duration: 0 } }));
    guestId = join('SUBS1', 'guest').sent.find(message => message.type === 'room:state').state.media.url;
  });
  afterAll(async () => { await api?.close(); vi.restoreAllMocks(); fs.rmSync(state.dir, { recursive: true, force: true }); });

  it('returns idle without resolving or extracting the origin', async () => {
    const res = await ask(soloToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toEqual({ stage: 'idle', updatedAt: expect.any(Number) });
    expect(state.originCalls).toBe(0);
  });

  it('requires the same session and track validation as the content route', async () => {
    expect((await ask(undefined)).status).toBe(401);
    expect((await ask(soloToken, secretUrl, '../3')).status).toBe(400);
    expect((await ask(soloToken, secretUrl, '')).status).toBe(400);
  });

  it('enforces opaque room access and uses the shared media fingerprint', async () => {
    expect((await ask(soloToken, guestId)).status).toBe(404);
    expect((await ask(issueRoomToken('SUBS2', 'other'), guestId)).status).toBe(404);
    subtitleProgress.set(getMediaFingerprint(secretUrl, `link:${guestId}`), '3', 'waiting_cdn', { retryAt: 123456, errorCode: 'UPSTREAM_RATE_LIMITED' });
    for (const [token, url] of [[issueRoomToken('SUBS1', 'guest'), guestId], [issueRoomToken('SUBS1', 'host'), secretUrl]]) {
      const res = await ask(token, url);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ stage: 'waiting_cdn', updatedAt: expect.any(Number), retryAt: 123456, errorCode: 'UPSTREAM_RATE_LIMITED' });
    }
    expect(state.originCalls).toBe(0);
  });

  it('reads validated cache using the stable client fingerprint and returns only public fields', async () => {
    const fingerprint = 'ih:status-test|file:0';
    writeCachedSubtitle(getMediaFingerprint(secretUrl, fingerprint), '3', '[Script Info]\n[Events]\nFormat: Layer, Start, End, Text\n', 'native-ass');
    const res = await ask(soloToken, secretUrl.replace('SECRET', 'ROTATED'), '3', `&fingerprint=${encodeURIComponent(fingerprint)}`);
    expect(await res.json()).toEqual({ stage: 'ready', updatedAt: expect.any(Number) });
    expect(state.originCalls).toBe(0);
  });
});
