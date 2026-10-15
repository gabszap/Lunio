import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.MIN_FREE_DISK_GB = '0';
process.env.ALLOW_PRIVATE_URLS = ''; // produção: a rede interna continua bloqueada, menos o caminho dos envios

type Api = Awaited<ReturnType<typeof import('./helpers').startApi>>;
let api: Api;
let host: { token: string };
let uploadsMod: typeof import('../media/uploads');
const created: string[] = [];
const ID = '0123456789abcdef';

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const helpers = await import('./helpers');
  const { createApiRouter } = await import('../app');
  const { roomManager } = await import('../roomServer');
  uploadsMod = await import('../media/uploads');
  api = await helpers.startApi(createApiRouter);
  host = helpers.joinRoom(roomManager, 'INTERNA1', 'host1');
});

afterAll(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const id of created) fs.rmSync(path.join(uploadsMod.UPLOAD_DIR, id), { recursive: true, force: true });
  await api.close();
  vi.restoreAllMocks();
});

describe('link de arquivo enviado', () => {
  it('reconhece o caminho relativo, o absoluto de qualquer host e o sob /.proxy; recusa o resto', () => {
    const { internalUploadUrl, ownUploadPath } = uploadsMod;
    expect(ownUploadPath(`/api/uploads/${ID}/video.mp4`)).toBe(`/api/uploads/${ID}/video.mp4`);
    expect(ownUploadPath(`https://lunio.stream/api/uploads/${ID}/a%20b.mkv`)).toBe(`/api/uploads/${ID}/a%20b.mkv`);
    expect(ownUploadPath(`https://x.discordsays.com/.proxy/api/uploads/${ID}/v.mp4`)).toBe(`/api/uploads/${ID}/v.mp4`);
    expect(ownUploadPath(`/api/uploads/curto/video.mp4`)).toBeNull();
    expect(ownUploadPath(`/api/uploads/${ID}/../../etc/passwd`)).toBeNull();
    expect(ownUploadPath('https://exemplo.test/video.mkv')).toBeNull();
    expect(internalUploadUrl('https://exemplo.test/video.mkv')).toBeNull();
    const own = internalUploadUrl(`https://lunio.stream/api/uploads/${ID}/v.mp4`)!;
    expect(own.startsWith(`${api.base}/api/uploads/${ID}/v.mp4?t=`)).toBe(true); // vai para o próprio servidor, não para o host do link
  });

  it('o endereço interno dos envios passa pela trava de rede interna; o resto da rede interna não', async () => {
    const { assertPublicUrl } = await import('../security');
    const { internalUploadUrl } = uploadsMod;
    await expect(assertPublicUrl(internalUploadUrl(`/api/uploads/${ID}/v.mp4`)!)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl(`${api.base}/api/session`)).rejects.toThrow();
    await expect(assertPublicUrl(`${api.base}/api/uploads/${ID}/../session`)).rejects.toThrow();
    await expect(assertPublicUrl('http://127.0.0.1:9/api/uploads/' + ID + '/v.mp4')).rejects.toThrow();
  });

  it('o proxy entrega o arquivo enviado com Range, e o resolvedor devolve um endereço que o servidor consegue ler', async () => {
    // Envia 2000 bytes pela API de pedaços
    const auth = { 'X-Lunio-Token': host.token };
    const start = await (await fetch(`${api.base}/api/upload/start?name=filme.mp4&size=2000`, { method: 'POST', headers: auth })).json();
    created.push(start.id);
    await fetch(`${api.base}/api/upload/${start.id}?offset=0`, { method: 'PUT', headers: auth, body: new Uint8Array(2000).map((_, i) => i % 251) });
    const done = await (await fetch(`${api.base}/api/upload/${start.id}/finish`, { method: 'POST', headers: auth })).json();
    const absolute = `https://lunio.stream${done.url}`; // o link como o navegador o guarda na sala

    const viaProxy = await fetch(`${api.base}/api/proxy?url=${encodeURIComponent(absolute)}`, { headers: { ...auth, Range: 'bytes=10-19' } });
    expect(viaProxy.status).toBe(206);
    expect(viaProxy.headers.get('content-range')).toBe('bytes 10-19/2000');
    expect(Array.from(new Uint8Array(await viaProxy.arrayBuffer()))).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

    // O que FFmpeg, extrator e HLS recebem do resolvedor: lê o arquivo de verdade
    const { resolveFinalCdnUrl } = await import('../media/resolver');
    const internal = await resolveFinalCdnUrl(absolute);
    const direct = await fetch(internal, { headers: { Range: 'bytes=0-4' } });
    expect(direct.status).toBe(206);
    expect((await direct.arrayBuffer()).byteLength).toBe(5);
  });
});
