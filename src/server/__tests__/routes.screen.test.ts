import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SESSION_SECRET = 'segredo-de-teste';

const { startApi, joinRoom, asWs } = await import('./helpers');
const { createApiRouter } = await import('../app');
const { roomManager } = await import('../roomServer');
const { config } = await import('../config');

/** POST /api/screen/token: URL do relay com o token certo para o papel de cada pessoa. */
describe('POST /api/screen/token', () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  const original = { ...config.screenShare };
  let n = 0;
  let roomId = '';
  let host: ReturnType<typeof joinRoom>;
  let guest: ReturnType<typeof joinRoom>;

  const ask = (token?: string, method = 'POST') =>
    fetch(`${api.base}/api/screen/token`, { method, headers: token ? { 'X-Lunio-Token': token } : {} });
  const msg = (who: typeof host, body: object) => roomManager.handleClientMessage(asWs(who.socket), JSON.stringify(body));

  beforeAll(async () => {
    api = await startApi(createApiRouter);
  });
  afterAll(async () => {
    await api?.close();
  });
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(config.screenShare, { enabled: true, relayUrl: 'https://relay.test', publishToken: 'TOKPUB', subscribeToken: 'TOKSUB', maxLive: 5 });
    roomId = `SCR${++n}`;
    host = joinRoom(roomManager, roomId, 'host');
    guest = joinRoom(roomManager, roomId, 'guest');
  });
  afterEach(() => {
    Object.assign(config.screenShare, original);
    vi.restoreAllMocks();
  });

  it('exige token de sessão, recusa token solo e outro método', async () => {
    expect((await ask()).status).toBe(401);
    const solo = ((await (await fetch(`${api.base}/api/session`, { method: 'POST' })).json()) as { token: string }).token;
    expect((await ask(solo)).status).toBe(403);
    expect((await ask(host.token, 'GET')).status).toBe(405);
  });

  it('com a flag desligada responde 503 screenshare_disabled', async () => {
    config.screenShare.enabled = false;
    const res = await ask(host.token);
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).code).toBe('screenshare_disabled');
  });

  it('sala sem transmissão responde 404 no_screen', async () => {
    const res = await ask(guest.token);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe('no_screen');
  });

  it('o Host da transmissão recebe o token de publicar', async () => {
    msg(host, { type: 'screen:start', quality: '1080p60' });
    const res = await ask(host.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ url: 'https://relay.test/TOKPUB', publish: true, quality: '1080p60' });
    expect(body.path).toBe(roomManager.getScreen(roomId)!.path);
    expect(body.sessionId).toBe(roomManager.getScreen(roomId)!.sessionId);
  });

  it('o espectador só recebe depois de ao vivo, e só o token de assistir', async () => {
    msg(host, { type: 'screen:start', quality: '720p30' });
    const early = await ask(guest.token);
    expect(early.status).toBe(409);
    expect(((await early.json()) as any).code).toBe('screen_not_live');

    msg(host, { type: 'screen:live' });
    const res = await ask(guest.token);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ url: 'https://relay.test/TOKSUB', publish: false });
    expect(text).not.toContain('TOKPUB');
  });

  it('banido depois de pegar o token de sala perde o acesso (401)', async () => {
    msg(host, { type: 'screen:start', quality: '720p30' });
    msg(host, { type: 'screen:live' });
    expect((await ask(guest.token)).status).toBe(200);
    msg(host, { type: 'room:ban', targetUserId: 'guest' });
    expect((await ask(guest.token)).status).toBe(401);
  });

  it('não escreve o corpo da resposta no console', async () => {
    msg(host, { type: 'screen:start', quality: '720p30' });
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
    await ask(host.token);
    expect(JSON.stringify(logs.flatMap((l) => l.mock.calls))).not.toMatch(/TOKPUB|TOKSUB/);
  });

  // Por último: esgota a janela de 30 pedidos por minuto deste IP
  it('o 31º pedido no mesmo minuto leva 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await ask(host.token)).status);
    expect(statuses).toContain(429);
    expect(statuses.indexOf(429)).toBeLessThanOrEqual(30);
  });
});
