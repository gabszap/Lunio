import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SESSION_SECRET = 'segredo-de-teste';

const { startApi, FakeSocket, asWs } = await import('./helpers');
const { createApiRouter } = await import('../app');
const { roomManager } = await import('../roomServer');
const { issueRoomToken } = await import('../access');
const { noteRateLimited, resetGateForTests } = await import('../media/upstreamGate');

const SECRET_LINK = 'https://provedor.test/dl/CHAVE-DO-HOST/video.mkv?token=CHAVE-DO-HOST';

/** As rotas com `?url=` aceitam o id opaco da sala do token no lugar do link (testado com /api/upstream, que não faz rede). */
describe('rotas com ?url= e o id opaco', () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  let soloToken: string;
  /** O que o espectador recebe no lugar do link do Host. */
  let guestId: string;
  const join = (roomId: string, id: string) => {
    const s = new FakeSocket();
    roomManager.handleClientMessage(asWs(s), JSON.stringify({ type: 'room:join', roomId, user: { id, username: id } }));
    return s;
  };
  const ask = (token: string, url: string) => fetch(`${api.base}/api/upstream?url=${encodeURIComponent(url)}`, { headers: { 'X-Lunio-Token': token } });

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api = await startApi(createApiRouter);
    soloToken = ((await (await fetch(`${api.base}/api/session`, { method: 'POST' })).json()) as { token: string }).token;

    const host = join('LKR1', 'host');
    join('LKR2', 'outro');
    roomManager.handleClientMessage(asWs(host), JSON.stringify({ type: 'media:set', media: { url: SECRET_LINK, title: 'Ep', duration: 0 } }));
    const guest = join('LKR1', 'guest');
    guestId = (guest as any).sent.find((m: any) => m.type === 'room:state').state.media.url;
  });
  afterAll(async () => {
    await api?.close();
  });
  beforeEach(() => resetGateForTests());

  it('quem está na sala usa o id e a rota age sobre o link de verdade', async () => {
    expect(guestId).toMatch(/^lk_/);
    noteRateLimited('provedor.test', 20);
    const res = await ask(issueRoomToken('LKR1', 'guest'), guestId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ limited: true, host: 'provedor.test' });
  });

  it('o link cru continua valendo (o dono e o fluxo de sempre)', async () => {
    const res = await ask(issueRoomToken('LKR1', 'host'), SECRET_LINK);
    expect(res.status).toBe(200);
  });

  it('id de outra sala, id inventado e sessão solo recebem 404 link_expired', async () => {
    for (const token of [issueRoomToken('LKR2', 'outro'), soloToken]) {
      const res = await ask(token, guestId);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'link_expired' });
    }
    const fake = await ask(issueRoomToken('LKR1', 'guest'), 'lk_' + 'q'.repeat(22));
    expect(fake.status).toBe(404);
  });
});
