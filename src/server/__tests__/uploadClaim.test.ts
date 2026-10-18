import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.MIN_FREE_DISK_GB = '0';
process.env.ALLOW_PRIVATE_URLS = '';

type Api = Awaited<ReturnType<typeof import('./helpers').startApi>>;
let api: Api;
let hostA: { token: string };
let hostB: { token: string };
let solo: string;
const created: string[] = [];
let uploadsMod: typeof import('../media/uploads');
let issueSoloToken: typeof import('../access').issueSoloToken;
let roomManager: typeof import('../roomServer').roomManager;

/** Envio completo em pedaços, do lado do host; devolve as respostas de start e finish. */
async function uploadViaChunks(hostToken: string, size = 2000, name = 'filme.mp4') {
  const auth = { 'X-Lunio-Token': hostToken };
  const start = await (await fetch(`${api.base}/api/upload/start?name=${encodeURIComponent(name)}&size=${size}`, { method: 'POST', headers: auth })).json();
  created.push(start.id);
  if (size > 0) {
    await fetch(`${api.base}/api/upload/${start.id}?offset=0`, { method: 'PUT', headers: auth, body: new Uint8Array(size) });
  }
  const finish = await (await fetch(`${api.base}/api/upload/${start.id}/finish`, { method: 'POST', headers: auth })).json();
  start.roomId = 'CLAIMA1';
  return { start, finish };
}

const metaDir = (id: string) => `${uploadsMod.UPLOAD_DIR}/${id}`;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const helpers = await import('./helpers');
  const { createApiRouter } = await import('../app');
  uploadsMod = await import('../media/uploads');
  ({ issueSoloToken } = await import('../access'));
  ({ roomManager } = await import('../roomServer'));
  api = await helpers.startApi(createApiRouter);
  hostA = helpers.joinRoom(roomManager, 'CLAIMA1', 'hostA');
  hostB = helpers.joinRoom(roomManager, 'CLAIMB2', 'hostB');
  solo = issueSoloToken().token;
});

afterAll(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const id of created) fs.rmSync(path.join(uploadsMod.UPLOAD_DIR, id), { recursive: true, force: true });
  await api.close();
  vi.restoreAllMocks();
});

describe('POST /api/uploads/claim (reabrir envio)', () => {
  it('o envio devolve o claim assinado no start e no fim', async () => {
    const uploaded = await uploadViaChunks(hostA.token);
    expect(uploaded.start.claim).toBeTypeOf('string');
    expect(uploaded.start.claim.length).toBeGreaterThan(40);
    expect(uploaded.finish.claim).toBeTypeOf('string'); // reemitido no fim: vale mesmo depois de retomar
  });

  it('claim válido de token solo reabre o envio confirmado: closedAt volta a null, roomId continua', async () => {
    const fs = await import('node:fs');
    const { start, finish } = await uploadViaChunks(hostA.token);
    fs.writeFileSync(`${metaDir(start.id)}/.meta.json`, JSON.stringify({ roomId: 'CLAIMA1', name: 'filme.mp4', createdAt: Date.now(), declaredSize: 2000, ownerId: 'hostA', closedAt: Date.now() - 60_000, complete: true }));

    const res = await fetch(`${api.base}/api/uploads/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lunio-Token': solo },
      body: JSON.stringify({ id: start.id, claim: finish.claim }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(start.id);
    expect(body.name).toBe('filme.mp4');
    expect(body.size).toBe(2000);
    expect(body.url).toBe(`/api/uploads/${start.id}/filme.mp4`);
    const meta = JSON.parse(fs.readFileSync(`${metaDir(start.id)}/.meta.json`, 'utf-8'));
    expect(meta.closedAt).toBeNull(); // reaberto: a limpeza por sala encerrada não o conta
    expect(meta.roomId).toBe('CLAIMA1'); // sem sala nova, fica na antiga
  });

  it('claim de Host de outra sala ativa move o envio para a sala dele', async () => {
    const { start, finish } = await uploadViaChunks(hostA.token);
    const fs = await import('node:fs');
    fs.writeFileSync(`${metaDir(start.id)}/.meta.json`, JSON.stringify({ roomId: 'CLAIMA1', name: 'movido.mp4', createdAt: Date.now(), declaredSize: 2000, ownerId: 'hostA', closedAt: 999, complete: true }));

    const res = await fetch(`${api.base}/api/uploads/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lunio-Token': hostB.token },
      body: JSON.stringify({ id: start.id, claim: finish.claim }),
    });
    expect(res.status).toBe(200);
    const meta = JSON.parse(fs.readFileSync(`${metaDir(start.id)}/.meta.json`, 'utf-8'));
    expect(meta.roomId).toBe('CLAIMB2');
    expect(meta.closedAt).toBeNull();
  });

  it('claim inválido, de outro id ou expirado: 403', async () => {
    const { finish } = await uploadViaChunks(hostA.token);
    const post = (claim: string, id = 'fedcba9876543210') =>
      fetch(`${api.base}/api/uploads/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lunio-Token': solo },
        body: JSON.stringify({ id, claim }),
      });
    expect((await post('lixo.impossivel')).status).toBe(403);
    expect((await post('')).status).toBe(403); // corpo sem claim: recusa, não explode
    // claim de um id apresentado como outro: assinatura não confere com o id pedido
    const wrongId = await post(finish.claim, 'fedcba9876543210');
    expect(wrongId.status).toBe(403);
  });

  it('sem token de quem pede: 401 (o claim sozinho não basta)', async () => {
    const { start, finish } = await uploadViaChunks(hostB.token);
    const res = await fetch(`${api.base}/api/uploads/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: start.id, claim: finish.claim }),
    });
    expect(res.status).toBe(401);
  });

  // Por último: deixa a sessão parada a meio na sala, que trava os próximos envios nela
  it('envio incompleto (parado a meio) não pode ser reaberto: 404', async () => {
    const auth = { 'X-Lunio-Token': hostA.token };
    const start = await (await fetch(`${api.base}/api/upload/start?name=parado.mp4&size=2000`, { method: 'POST', headers: auth })).json();
    created.push(start.id);
    const res = await fetch(`${api.base}/api/uploads/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lunio-Token': solo },
      body: JSON.stringify({ id: start.id, claim: start.claim }),
    });
    expect(res.status).toBe(404); // retira da lista do navegador: o arquivo não está completo
  });
});
