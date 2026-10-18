import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.MIN_FREE_DISK_GB = '0'; // o teste não depende de quanto o disco do desenvolvedor tem livre
process.env.ALLOW_PRIVATE_URLS = '';

type Api = Awaited<ReturnType<typeof import('./helpers').startApi>>;
let api: Api;
let helpers: typeof import('./helpers');
let host: { token: string };
let guest: { token: string };
let soloToken: string;
const UPLOADS = path.resolve(process.cwd(), '.uploads');
const created = new Set<string>();

const json = async (res: Response) => res.json() as Promise<any>;
const auth = (token: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers as object), 'X-Lunio-Token': token } });

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  helpers = await import('./helpers');
  const { createApiRouter } = await import('../app');
  const manager = (await import('../roomServer')).roomManager;
  api = await helpers.startApi(createApiRouter);
  soloToken = (await json(await fetch(`${api.base}/api/session`, { method: 'POST' }))).token;
  host = helpers.joinRoom(manager, 'PEDACOS', 'host1');
  guest = helpers.joinRoom(manager, 'PEDACOS', 'guest1');
});

afterAll(async () => {
  await api.close();
  for (const id of created) fs.rmSync(path.join(UPLOADS, id), { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Cada teste deixa a sala livre para o próximo: um envio recém-ativo da mesma sala bloquearia o `start` seguinte (409)
afterEach(async () => {
  for (const id of created) await fetch(`${api.base}/api/upload/${id}`, auth(host.token, { method: 'DELETE' })).catch(() => {});
});

const start = async (size: number, name = 'video.mp4', token = host.token) => {
  const res = await fetch(`${api.base}/api/upload/start?name=${encodeURIComponent(name)}&size=${size}`, auth(token, { method: 'POST' }));
  const body = await json(res);
  if (body.id) created.add(body.id);
  return { res, body };
};
const put = (id: string, offset: number, bytes: Uint8Array, token = host.token) =>
  fetch(`${api.base}/api/upload/${id}?offset=${offset}`, auth(token, { method: 'PUT', body: bytes }));
const status = (id: string, token = host.token) => fetch(`${api.base}/api/upload/${id}`, auth(token));
const finish = (id: string, token = host.token) => fetch(`${api.base}/api/upload/${id}/finish`, auth(token, { method: 'POST' }));
const cancel = (id: string, token = host.token) => fetch(`${api.base}/api/upload/${id}`, auth(token, { method: 'DELETE' }));
const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

/** PUT que corta a conexão no meio do corpo (como o proxy ou a rede fariam). */
function putAndCut(id: string, offset: number, declared: number, sent: number, token = host.token) {
  const u = new URL(api.base);
  return new Promise<void>((resolve) => {
    const req = http.request({
      host: u.hostname,
      port: u.port,
      method: 'PUT',
      path: `/api/upload/${id}?offset=${offset}`,
      headers: { 'X-Lunio-Token': token, 'Content-Length': String(declared), 'Content-Type': 'application/octet-stream' },
    });
    req.on('error', () => {});
    req.write(Buffer.alloc(sent, 9));
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 250);
  });
}

describe('envio em pedaços', () => {
  it('só o Host da sala começa um envio', async () => {
    expect((await start(1000, 'a.mp4', guest.token)).res.status).toBe(403);
    expect((await start(1000, 'a.mp4', soloToken)).res.status).toBe(403);
    const noToken = await fetch(`${api.base}/api/upload/start?name=a.mp4&size=10`, { method: 'POST' });
    expect(noToken.status).toBe(401);
  });

  it('os metadados guardam o dono do envio e `closedAt` começa em null', async () => {
    const { body } = await start(100, 'dono.mp4');
    expect(body.id).toBeTruthy();
    const meta = JSON.parse(fs.readFileSync(path.join(UPLOADS, body.id, '.meta.json'), 'utf-8'));
    expect(meta.ownerId).toBe('host1'); // o id do Host que fez o envio
    expect(meta.closedAt).toBeNull();   // sala de pé: não fechada
  });

  it('sobe em pedaços, confere a posição e entrega o arquivo inteiro e íntegro', async () => {
    const { res, body } = await start(3000, 'serie.mp4');
    expect(res.status).toBe(200);
    expect(body.chunkSize).toBeGreaterThan(0);
    expect(body.received).toBe(0);

    expect((await json(await put(body.id, 0, bytes(1000, 1)))).received).toBe(1000);
    expect((await json(await put(body.id, 1000, bytes(1000, 2)))).received).toBe(2000);
    expect(await json(await status(body.id))).toMatchObject({ received: 2000, size: 3000 });
    expect((await json(await put(body.id, 2000, bytes(1000, 3)))).received).toBe(3000);

    const done = await json(await finish(body.id));
    expect(done).toMatchObject({ id: body.id, name: 'serie.mp4', size: 3000 });
    const file = new Uint8Array(await (await fetch(`${api.base}${done.url}`, auth(host.token))).arrayBuffer());
    expect(file.length).toBe(3000);
    expect([file[0], file[1500], file[2999]]).toEqual([1, 2, 3]);
  });

  it('posição errada: 409 com o ponto certo para continuar (reenviar o mesmo pedaço também)', async () => {
    const { body } = await start(2000);
    await put(body.id, 0, bytes(500, 1));
    const repeated = await put(body.id, 0, bytes(500, 1));
    expect(repeated.status).toBe(409);
    expect(await json(repeated)).toMatchObject({ code: 'offset_mismatch', received: 500 });
    const ahead = await put(body.id, 900, bytes(100, 1));
    expect(ahead.status).toBe(409);
    expect((await json(ahead)).received).toBe(500);
  });

  it('conexão cortada no meio de um pedaço: nada é confirmado e o reenvio sobrescreve a sobra', async () => {
    const { body } = await start(2000);
    await put(body.id, 0, bytes(1000, 1));
    await putAndCut(body.id, 1000, 1000, 400); // 400 de 1000 chegaram, e então a conexão caiu
    await new Promise((r) => setTimeout(r, 300));
    expect((await json(await status(body.id))).received).toBe(1000);

    expect((await put(body.id, 1000, bytes(1000, 7))).status).toBe(200);
    const done = await json(await finish(body.id));
    const file = new Uint8Array(await (await fetch(`${api.base}${done.url}`, auth(host.token))).arrayBuffer());
    expect(file.length).toBe(2000);
    expect([file[999], file[1000], file[1399], file[1999]]).toEqual([1, 7, 7, 7]); // sem os 9 da sobra
  });

  it('concluir antes de chegar tudo: 409; pedaço que passa do tamanho declarado: 413', async () => {
    const { body } = await start(1000);
    await put(body.id, 0, bytes(400, 1));
    const early = await finish(body.id);
    expect(early.status).toBe(409);
    expect((await json(early)).received).toBe(400);
    expect((await put(body.id, 400, bytes(700, 1))).status).toBe(413);
  });

  it('cancelar apaga o envio e libera a sala para começar outro na hora', async () => {
    const { body } = await start(5000);
    await put(body.id, 0, bytes(100, 1));
    expect((await start(5000)).res.status).toBe(409); // acabou de receber pedaço: ainda conta como em andamento
    expect((await cancel(body.id)).status).toBe(204);
    expect((await status(body.id)).status).toBe(404);
    expect(fs.existsSync(path.join(UPLOADS, body.id))).toBe(false);
    expect((await start(5000)).res.status).toBe(200);
  });

  it('validações: tamanho ausente, arquivo acima do limite, id inexistente', async () => {
    const noSize = await fetch(`${api.base}/api/upload/start?name=a.mp4`, auth(host.token, { method: 'POST' }));
    expect(noSize.status).toBe(400);
    const huge = await fetch(`${api.base}/api/upload/start?name=a.mp4&size=${60 * 1024 ** 3}`, auth(host.token, { method: 'POST' }));
    expect(huge.status).toBe(413);
    expect((await status('0123456789abcdef')).status).toBe(404);
    expect((await status('nao-e-um-id')).status).toBe(404);
  });
});
