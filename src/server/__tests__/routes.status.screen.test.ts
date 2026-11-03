import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SESSION_SECRET = 'segredo-de-teste';

const { startApi, joinRoom, asWs } = await import('./helpers');
const { createApiRouter } = await import('../app');
const { roomManager } = await import('../roomServer');
const { config } = await import('../config');
const { recordScreenUsage, resetScreenUsageForTests } = await import('../screenUsage');

describe('GET /api/status (screen)', () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  const original = { ...config.screenShare };
  const status = async () => (await (await fetch(`${api.base}/api/status`)).json()) as any;

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api = await startApi(createApiRouter);
  });
  afterAll(async () => {
    Object.assign(config.screenShare, original);
    await api?.close();
  });
  beforeEach(() => resetScreenUsageForTests());

  it('diz se a transmissão de tela está ligada e quantas estão ao vivo', async () => {
    Object.assign(config.screenShare, { enabled: false });
    expect((await status()).screen).toEqual({ enabled: false, live: 0, hostBytes: 0, estimatedEgressBytes: 0 });

    Object.assign(config.screenShare, { enabled: true, relayUrl: 'https://relay.test', publishToken: 'P', subscribeToken: 'S', maxLive: 5 });
    const host = joinRoom(roomManager, 'STATUSSCR', 'host');
    roomManager.handleClientMessage(asWs(host.socket), JSON.stringify({ type: 'screen:start', quality: '720p30' }));
    roomManager.handleClientMessage(asWs(host.socket), JSON.stringify({ type: 'screen:live' }));
    recordScreenUsage(2000, 2);
    expect((await status()).screen).toEqual({ enabled: true, live: 1, hostBytes: 2000, estimatedEgressBytes: 4000 });
  });

  it('não expõe tokens nem endereço do relay', async () => {
    const text = JSON.stringify(await status());
    expect(text).not.toContain('relay.test');
  });
});
