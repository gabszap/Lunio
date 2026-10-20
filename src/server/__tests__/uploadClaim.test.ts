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

  it('reabrir numa sala de Host ativa vale a regra "uma sala, um envio": o envio velho da sala sai', async () => {
    const fs = await import('node:fs');
    // o CLAIMB2 já tinha um envio na cara dura; o claim de outro envio passa a substituí-lo na hora
    const velho = await uploadViaChunks(hostB.token, 1500, 'velho.mp4');
    fs.writeFileSync(`${metaDir(velho.start.id)}/.meta.json`, JSON.stringify({ roomId: 'CLAIMB2', name: 'velho.mp4', createdAt: Date.now(), declaredSize: 1500, ownerId: 'hostB', closedAt: null, complete: true }));
    const novo = await uploadViaChunks(hostA.token, 2000, 'novo.mp4');
    fs.writeFileSync(`${metaDir(novo.start.id)}/.meta.json`, JSON.stringify({ roomId: 'CLAIMA1', name: 'novo.mp4', createdAt: Date.now(), declaredSize: 2000, ownerId: 'hostA', closedAt: 999, complete: true }));

    const res = await fetch(`${api.base}/api/uploads/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lunio-Token': hostB.token },
      body: JSON.stringify({ id: novo.start.id, claim: novo.finish.claim }),
    });
    expect(res.status).toBe(200);
    const meta = JSON.parse(fs.readFileSync(`${metaDir(novo.start.id)}/.meta.json`, 'utf-8'));
    expect(meta.roomId).toBe('CLAIMB2');
    expect(fs.existsSync(metaDir(velho.start.id))).toBe(false); // o velho saiu com o claim, como num envio novo
    expect(fs.existsSync(metaDir(novo.start.id))).toBe(true);
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

  const post = (url: string, token: string, body: unknown) =>
    fetch(`${api.base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lunio-Token': token }, body: JSON.stringify(body) });

  it('reabrir sem sala que o receba renova o prazo (closedAt = agora), devolve claim novo e diz quando vence', async () => {
    const fs = await import('node:fs');
    const { verifyToken } = await import('../access');
    const { config } = await import('../config');
    const { start, finish } = await uploadViaChunks(hostB.token);
    // A sala do envio já morreu (não está na memória) e fechou há 20 h
    const metaPath = `${metaDir(start.id)}/.meta.json`;
    fs.writeFileSync(metaPath, JSON.stringify({ roomId: 'SALAMORTA1', name: 'filme.mp4', createdAt: Date.now(), declaredSize: 2000, ownerId: 'hostB', closedAt: Date.now() - 20 * 3600_000, complete: true }));

    const before = Date.now();
    const res = await post('/api/uploads/claim', solo, { id: start.id, claim: finish.claim });
    expect(res.status).toBe(200);
    const body = await res.json();
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

    // Antes voltava a `null` e a limpeza passava a contar do início do processo; agora o prazo recomeça de agora
    expect(meta.closedAt).toBeGreaterThanOrEqual(before);
    expect(meta.roomId).toBe('SALAMORTA1');
    expect(body.expiresAt).toBe(meta.closedAt + config.uploadTtlMs);
    expect(body.claim).not.toBe(finish.claim);
    expect(verifyToken(body.claim)).toMatchObject({ k: 'upload', id: start.id });
  });

  it('o claim vale 7 dias, não 24 h (o prazo de verdade é o do arquivo, que o servidor informa)', async () => {
    const { verifyToken } = await import('../access');
    const { finish } = await uploadViaChunks(hostB.token);
    const payload = verifyToken(finish.claim) as { exp: number };
    expect(payload.exp - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);
  });

  it('POST /api/uploads/status diz o que existe, o que sumiu e o que tem claim inválido, com o prazo real', async () => {
    const fs = await import('node:fs');
    const { issueUploadClaim } = await import('../access');
    const { config } = await import('../config');
    const { start, finish } = await uploadViaChunks(hostB.token); // sala ativa: o prazo depende de quanto ainda se lê
    const gone = '0123456789abcdef';

    const first = await (
      await post('/api/uploads/status', solo, {
        items: [{ id: start.id, claim: finish.claim }, { id: gone, claim: issueUploadClaim(gone, 'x') }, { id: start.id, claim: 'lixo' }],
      })
    ).json();
    expect(first.items.map((i: { state: string }) => i.state)).toEqual(['ok', 'gone', 'invalid']);
    expect(first.items[0].expiresAt).toBeNull();

    // Sala fechada há 2 h: vence 24 h depois do fechamento
    const closedAt = Date.now() - 2 * 3600_000;
    fs.writeFileSync(`${metaDir(start.id)}/.meta.json`, JSON.stringify({ roomId: 'SALAMORTA2', name: 'filme.mp4', createdAt: Date.now(), declaredSize: 2000, ownerId: 'hostB', closedAt, complete: true }));
    const second = await (await post('/api/uploads/status', solo, { items: [{ id: start.id, claim: finish.claim }] })).json();
    expect(second.items[0]).toMatchObject({ state: 'ok', expiresAt: closedAt + config.uploadTtlMs });

    expect((await post('/api/uploads/status', solo, { items: 'nao-e-lista' })).status).toBe(400);
    expect((await post('/api/uploads/status', solo, { items: Array.from({ length: 30 }, () => ({})) }).then((r) => r.json())).items).toHaveLength(10);
  });

  it('o claim não serve como token de sessão (antes o gate o tratava como sessão solo)', async () => {
    const { finish } = await uploadViaChunks(hostB.token);
    const res = await fetch(`${api.base}/api/uploads/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lunio-Token': finish.claim },
      body: JSON.stringify({ items: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('o dono do envio é a pessoa, não a aba: o sufixo _tab#### sai do ownerId', async () => {
    const fs = await import('node:fs');
    const helpers = await import('./helpers');
    const tabHost = helpers.joinRoom(roomManager, 'CLAIMC3', 'hostC_tab0001');
    const { start } = await uploadViaChunks(tabHost.token);
    const meta = JSON.parse(fs.readFileSync(`${metaDir(start.id)}/.meta.json`, 'utf-8'));
    expect(meta.ownerId).toBe('hostC');
  });

  it('corpo do claim que a conexão corta no meio não deixa o handler pendurado', async () => {
    const http = await import('node:http');
    const u = new URL(api.base);
    await new Promise<void>((resolve) => {
      const req = http.request({ host: u.hostname, port: u.port, method: 'POST', path: '/api/uploads/claim', headers: { 'Content-Type': 'application/json', 'X-Lunio-Token': solo, 'Content-Length': '500' } });
      req.on('error', () => {});
      req.write('{"id":"');
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 150);
    });
    // O servidor continua respondendo normalmente (um handler pendurado não derruba nada, mas vazava a requisição)
    const ok = await post('/api/uploads/status', solo, { items: [] });
    expect(ok.status).toBe(200);
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
