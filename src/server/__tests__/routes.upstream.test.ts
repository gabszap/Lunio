import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SESSION_SECRET = 'segredo-de-teste';

const { startApi } = await import('./helpers');
const { createApiRouter } = await import('../app');
const { noteRateLimited, resetGateForTests, cooldownRemainingMs } = await import('../media/upstreamGate');
const { cacheResolved, invalidateResolvedUrl } = await import('../media/resolver');

/** GET /api/upstream: o provedor deste vídeo limitou os pedidos agora? (o player usa na tela de erro) */
describe('GET /api/upstream', () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  let token: string;
  const ask = async (url?: string) => {
    const q = url === undefined ? '' : `?url=${encodeURIComponent(url)}`;
    return fetch(`${api.base}/api/upstream${q}`, { headers: { 'X-Lunio-Token': token } });
  };

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api = await startApi(createApiRouter);
    token = ((await (await fetch(`${api.base}/api/session`, { method: 'POST' })).json()) as { token: string }).token;
  });
  afterAll(async () => {
    await api?.close();
  });
  beforeEach(() => resetGateForTests());

  it('exige o token de sessão e a url', async () => {
    expect((await fetch(`${api.base}/api/upstream?url=${encodeURIComponent('https://p.test/a')}`)).status).toBe(401);
    expect((await ask()).status).toBe(400);
    expect((await ask('javascript:alert(1)')).status).toBe(400);
  });

  it('host sem limite: limited false', async () => {
    const body = (await (await ask('https://provedor.test/video.mkv')).json()) as any;
    expect(body).toMatchObject({ limited: false, host: '' });
  });

  it('host que respondeu 429: limited true, com o host e o tempo de espera', async () => {
    noteRateLimited('provedor.test', 12);
    const body = (await (await ask('https://provedor.test/video.mkv')).json()) as any;
    expect(body.limited).toBe(true);
    expect(body.host).toBe('provedor.test');
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(body.retryAfterSec).toBeLessThanOrEqual(12);
  });

  it('também enxerga o limite no CDN já resolvido do vídeo', async () => {
    cacheResolved('https://origem.test/stream', 'https://cdn.test/arquivo.mkv');
    noteRateLimited('cdn.test', 8);
    const body = (await (await ask('https://origem.test/stream')).json()) as any;
    expect(body).toMatchObject({ limited: true, host: 'cdn.test' });
    invalidateResolvedUrl('https://origem.test/stream');
  });

  it('perguntar por um host nunca visto não deixa rastro no portão', async () => {
    await ask('https://nunca-visto.test/x');
    expect(cooldownRemainingMs('nunca-visto.test')).toBe(0);
  });
});
