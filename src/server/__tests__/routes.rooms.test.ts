import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

process.env.SESSION_SECRET = 'segredo-de-teste';

const { startApi, FakeSocket, asWs } = await import('./helpers');
const { createApiRouter } = await import('../app');
const { RoomManager, roomManager, PREVIEW_TTL_MS, PREVIEW_MAX_BYTES } = await import('../roomServer');
const { config } = await import('../config');
import type { RoomManager as RoomManagerInstance } from '../roomServer';
import type { PersistedRoom, RoomStore } from '../roomStore';

const VALID_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const VALID_WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x14, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from('VP8 ', 'ascii'),
  Buffer.from([0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
]);

function makeMemoryStore(saved: Map<string, PersistedRoom>): RoomStore {
  return {
    async save(room) {
      saved.set(room.roomId, structuredClone(room));
    },
    async remove(roomId) {
      saved.delete(roomId);
    },
    async loadAll() {
      return { rooms: Array.from(saved.values()), closed: [] };
    },
  };
}

async function joinCustom(
  manager: RoomManagerInstance,
  roomId: string,
  user: { id: string; username: string; avatarUrl?: string },
  initialSettings?: { name?: string; visibility?: 'public' | 'private'; password?: string }
) {
  const socket = new FakeSocket();
  await manager.handleClientMessage(
    asWs(socket),
    JSON.stringify({
      type: 'room:join',
      roomId,
      initialSettings,
      user,
    })
  );
  const stateMsg = socket.last('room:state');
  return { socket, token: stateMsg?.accessToken as string, assignedUserId: stateMsg?.assignedUserId as string };
}

async function sendMsg(manager: RoomManagerInstance, socket: InstanceType<typeof FakeSocket>, msg: object) {
  await manager.handleClientMessage(asWs(socket), JSON.stringify(msg));
}

describe('RoomManager — listPublicRooms e previews efêmeros em memória', () => {
  let rm: RoomManagerInstance;
  let savedRooms: Map<string, PersistedRoom>;
  const originalScreen = { ...config.screenShare };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(config.screenShare, { enabled: true, relayUrl: 'https://relay.test', publishToken: 'PUB', subscribeToken: 'SUB', maxLive: 5 });
    savedRooms = new Map();
    rm = new RoomManager(makeMemoryStore(savedRooms));
  });

  afterEach(() => {
    Object.assign(config.screenShare, originalScreen);
    vi.restoreAllMocks();
  });

  it('lista apenas salas públicas, abertas e com membros; oculta privadas, trancadas e vazias; nunca vaza media.url nem passwordHash', async () => {
    // 1. Sala pública com mídia e 10 membros + aba duplicada do Host
    const hostPub = await joinCustom(
      rm,
      'PUB1',
      { id: 'host1', username: 'AnaHost', avatarUrl: 'https://img.test/ana.png' },
      { name: 'Cine Noite', visibility: 'public' }
    );
    // Segunda aba do mesmo Host (deve deduplicar mantendo isHost: true)
    await joinCustom(rm, 'PUB1', { id: 'host1', username: 'AnaHost', avatarUrl: 'https://img.test/ana.png' });
    for (let i = 1; i <= 9; i++) {
      await joinCustom(rm, 'PUB1', { id: `u${i}`, username: `User${i}` });
    }
    // Segunda aba de um espectador também deduplica
    await joinCustom(rm, 'PUB1', { id: 'u1', username: 'User1' });

    await sendMsg(rm, hostPub.socket, {
      type: 'media:set',
      media: {
        url: 'https://segredo.example/token=SUPERSECRETO/filme.mkv',
        title: 'Interestelar',
        duration: 10000,
      },
    });

    // 2. Sala pública sem nome customizado e sem mídia (idle)
    await joinCustom(rm, 'IDLE1', { id: 'h2', username: 'Bruno' });

    // 3. Sala pública transmitindo tela (activity: 'screen', screenLive: true)
    const hostScreen = await joinCustom(rm, 'SCRN1', { id: 'h3', username: 'Carla' }, { name: 'Jogatina', visibility: 'public' });
    await sendMsg(rm, hostScreen.socket, { type: 'screen:start', quality: '1080p60' });
    await sendMsg(rm, hostScreen.socket, { type: 'screen:live' });

    // 4. Sala privada com senha (NUNCA deve aparecer)
    await joinCustom(
      rm,
      'PRIV1',
      { id: 'h4', username: 'PrivUser' },
      { name: 'Secreta', visibility: 'private', password: 'minha-senha-ultra-secreta' }
    );

    // 5. Sala pública trancada (NUNCA deve aparecer)
    const hostLocked = await joinCustom(rm, 'LOCK1', { id: 'h5', username: 'LockUser' }, { name: 'Trancada', visibility: 'public' });
    await sendMsg(rm, hostLocked.socket, { type: 'room:settings', locked: true });

    // 6. Sala pública vazia (NUNCA deve aparecer)
    const hostEmpty = await joinCustom(rm, 'EMPT1', { id: 'h6', username: 'EmptyUser' });
    rm.handleLeave(asWs(hostEmpty.socket), true);

    const list = rm.listPublicRooms();
    const codes = list.map((r) => r.code).sort();
    expect(codes).toEqual(['IDLE1', 'PUB1', 'SCRN1']);

    const pub = list.find((r) => r.code === 'PUB1')!;
    expect(pub).toMatchObject({
      code: 'PUB1',
      name: 'Cine Noite',
      hostName: 'AnaHost',
      membersCount: 10,
      hasMedia: true,
      mediaTitle: 'Interestelar',
      screenLive: false,
      activity: 'media',
      previewUrl: null,
    });
    expect(pub.members).toHaveLength(8);
    expect(pub.members[0]).toEqual({ username: 'AnaHost', avatarUrl: 'https://img.test/ana.png', isHost: true });
    expect(pub.members.slice(1).every((m) => !m.isHost)).toBe(true);
    expect(typeof pub.createdAt).toBe('number');

    const idle = list.find((r) => r.code === 'IDLE1')!;
    expect(idle).toMatchObject({
      code: 'IDLE1',
      name: 'IDLE1',
      hostName: 'Bruno',
      membersCount: 1,
      hasMedia: false,
      mediaTitle: null,
      screenLive: false,
      activity: 'idle',
      previewUrl: null,
    });

    const scrn = list.find((r) => r.code === 'SCRN1')!;
    expect(scrn).toMatchObject({
      code: 'SCRN1',
      name: 'Jogatina',
      screenLive: true,
      activity: 'screen',
    });

    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain('segredo.example');
    expect(serialized).not.toContain('SUPERSECRETO');
    expect(serialized).not.toContain('minha-senha-ultra-secreta');
    expect(serialized).not.toContain('passwordHash');
  });

  it('limpa preview automaticamente ao mudar para privada, trancar, trocar mídia, parar tela, esvaziar sala e após TTL de 90s; nunca persiste preview no Redis', async () => {
    expect(PREVIEW_TTL_MS).toBe(90_000);
    expect(PREVIEW_MAX_BYTES).toBe(65_536);

    const host = await joinCustom(rm, 'LIFE1', { id: 'h1', username: 'Host' });

    // Upload inicial e incremento monotônico de versão
    const r1 = rm.setRoomPreview('LIFE1', VALID_JPEG, 'image/jpeg');
    expect(r1).toEqual({ ok: true, version: 1 });
    expect(rm.listPublicRooms()[0].previewUrl).toBe('/api/rooms/LIFE1/preview?v=1');

    // Persiste no store (Redis) e garante que preview NÃO vai ao store nem ao RoomState
    await rm.flushPersistence();
    const persisted = savedRooms.get('LIFE1') as unknown as Record<string, unknown>;
    expect(persisted).toBeDefined();
    expect(JSON.stringify(persisted)).not.toContain('preview');

    // 1) Virar privada limpa preview (e não volta se tornar pública depois)
    await sendMsg(rm, host.socket, { type: 'room:settings', visibility: 'private' });
    expect(rm.getRoomPreview('LIFE1')).toBeNull();
    expect(rm.setRoomPreview('LIFE1', VALID_JPEG, 'image/jpeg')).toEqual({ ok: false, reason: 'not_public' });
    await sendMsg(rm, host.socket, { type: 'room:settings', visibility: 'public' });
    expect(rm.getRoomPreview('LIFE1')).toBeNull();

    // 2) Trancar sala limpa preview (versão continua crescendo monotonicamente)
    const r2 = rm.setRoomPreview('LIFE1', VALID_WEBP, 'image/webp');
    expect(r2).toEqual({ ok: true, version: 2 });
    await sendMsg(rm, host.socket, { type: 'room:settings', locked: true });
    expect(rm.getRoomPreview('LIFE1')).toBeNull();
    expect(rm.setRoomPreview('LIFE1', VALID_JPEG, 'image/jpeg')).toEqual({ ok: false, reason: 'not_public' });
    await sendMsg(rm, host.socket, { type: 'room:settings', locked: false });
    expect(rm.getRoomPreview('LIFE1')).toBeNull();

    // 3) media:set limpa preview
    expect(rm.setRoomPreview('LIFE1', VALID_JPEG, 'image/jpeg')).toEqual({ ok: true, version: 3 });
    await sendMsg(rm, host.socket, {
      type: 'media:set',
      media: { url: 'https://cdn.example/v.mp4', title: 'Outro', duration: 120 },
    });
    expect(rm.getRoomPreview('LIFE1')).toBeNull();

    // 4) screen:stop limpa preview
    await sendMsg(rm, host.socket, { type: 'screen:start', quality: '720p30' });
    await sendMsg(rm, host.socket, { type: 'screen:live' });
    expect(rm.setRoomPreview('LIFE1', VALID_JPEG, 'image/jpeg')).toEqual({ ok: true, version: 4 });
    await sendMsg(rm, host.socket, { type: 'screen:stop' });
    expect(rm.getRoomPreview('LIFE1')).toBeNull();

    // 5) TTL de 90s expira o preview
    const baseNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    expect(rm.setRoomPreview('LIFE1', VALID_JPEG, 'image/jpeg')).toEqual({ ok: true, version: 5 });
    nowSpy.mockReturnValue(baseNow + PREVIEW_TTL_MS);
    expect(rm.getRoomPreview('LIFE1')).not.toBeNull();
    expect(rm.listPublicRooms()[0].previewUrl).toBe('/api/rooms/LIFE1/preview?v=5');

    nowSpy.mockReturnValue(baseNow + PREVIEW_TTL_MS + 1);
    expect(rm.listPublicRooms()[0].previewUrl).toBeNull();
    expect(rm.getRoomPreview('LIFE1')).toBeNull();
    nowSpy.mockRestore();

    // 6) Sala vazia limpa preview
    expect(rm.setRoomPreview('LIFE1', VALID_JPEG, 'image/jpeg')).toEqual({ ok: true, version: 6 });
    rm.handleLeave(asWs(host.socket), true);
    expect(rm.getRoomPreview('LIFE1')).toBeNull();
    // Novo membro entra na mesma sala: preview antigo não reaparece
    await joinCustom(rm, 'LIFE1', { id: 'h2', username: 'NovoHost' });
    expect(rm.getRoomPreview('LIFE1')).toBeNull();

    // Sala inexistente
    expect(rm.setRoomPreview('NOPE99', VALID_JPEG, 'image/jpeg')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('Rotas HTTP /api/rooms e /api/roompreview', () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  let soloToken: string;
  const activeSockets: WebSocket[] = [];

  const trackJoin = async (
    roomId: string,
    user: { id: string; username: string; avatarUrl?: string },
    initialSettings?: { name?: string; visibility?: 'public' | 'private'; password?: string }
  ) => {
    const joined = await joinCustom(roomManager, roomId, user, initialSettings);
    activeSockets.push(asWs(joined.socket));
    return joined;
  };

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api = await startApi(createApiRouter);
    const soloRes = await fetch(`${api.base}/api/session`, { method: 'POST' });
    soloToken = ((await soloRes.json()) as { token: string }).token;
  });

  afterAll(async () => {
    for (const ws of activeSockets) roomManager.handleLeave(ws, true);
    await api?.close();
    vi.restoreAllMocks();
  });

  it('GET /api/rooms lista salas públicas com Cache-Control: no-store e rejeita métodos não-GET', async () => {
    const pub = await trackJoin('HTTPPUB1', { id: 'hp1', username: 'HostPub' }, { name: 'Sala Aberta', visibility: 'public' });
    await trackJoin('HTTPPRIV1', { id: 'hv1', username: 'HostPriv' }, { name: 'Privada', visibility: 'private', password: 'abc' });
    await sendMsg(roomManager, pub.socket, {
      type: 'media:set',
      media: { url: 'https://secret.cdn.test/private-token/movie.mp4', title: 'Duna', duration: 9000 },
    });

    const res = await fetch(`${api.base}/api/rooms`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { rooms: any[]; total: number };
    expect(body.total).toBe(body.rooms.length);

    const found = body.rooms.find((r) => r.code === 'HTTPPUB1');
    expect(found).toMatchObject({
      code: 'HTTPPUB1',
      name: 'Sala Aberta',
      hostName: 'HostPub',
      membersCount: 1,
      hasMedia: true,
      mediaTitle: 'Duna',
      activity: 'media',
    });
    expect(body.rooms.find((r) => r.code === 'HTTPPRIV1')).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('secret.cdn.test');

    const badMethod = await fetch(`${api.base}/api/rooms`, { method: 'POST' });
    expect(badMethod.status).toBe(405);
  });

  it('PUT /api/roompreview aceita JPEG e WebP válidos do Host, serve em GET /api/rooms/:code/preview com headers de segurança e DELETE remove (204)', async () => {
    const host = await trackJoin('PREVHTTP1', { id: 'ph1', username: 'HostPrev' }, { name: 'Com Preview', visibility: 'public' });

    // Antes do upload -> 404
    expect((await fetch(`${api.base}/api/rooms/PREVHTTP1/preview`)).status).toBe(404);

    // Upload JPEG válido
    const putJpeg = await fetch(`${api.base}/api/roompreview`, {
      method: 'PUT',
      headers: { 'X-Lunio-Token': host.token, 'Content-Type': 'image/jpeg' },
      body: VALID_JPEG,
    });
    expect(putJpeg.status).toBe(200);
    const jpegJson = (await putJpeg.json()) as { version: number };
    expect(jpegJson.version).toBe(1);

    // GET /api/rooms mostra previewUrl
    const listRes = await fetch(`${api.base}/api/rooms`);
    const listJson = (await listRes.json()) as { rooms: any[] };
    const card = listJson.rooms.find((r) => r.code === 'PREVHTTP1');
    expect(card.previewUrl).toBe('/api/rooms/PREVHTTP1/preview?v=1');

    // GET /api/rooms/:code/preview (case-insensitive)
    const getJpeg = await fetch(`${api.base}/api/rooms/prevhttp1/preview?v=1`);
    expect(getJpeg.status).toBe(200);
    expect(getJpeg.headers.get('content-type')).toBe('image/jpeg');
    expect(getJpeg.headers.get('cache-control')).toBe('no-store');
    expect(getJpeg.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await getJpeg.arrayBuffer()).equals(VALID_JPEG)).toBe(true);

    // Upload WebP válido (com parâmetro de charset/extra no Content-Type)
    const putWebp = await fetch(`${api.base}/api/roompreview`, {
      method: 'PUT',
      headers: { 'X-Lunio-Token': host.token, 'Content-Type': 'image/webp; charset=binary' },
      body: VALID_WEBP,
    });
    expect(putWebp.status).toBe(200);
    expect(await putWebp.json()).toEqual({ version: 2 });

    const getWebp = await fetch(`${api.base}/api/rooms/PREVHTTP1/preview?v=2`);
    expect(getWebp.status).toBe(200);
    expect(getWebp.headers.get('content-type')).toBe('image/webp');
    expect(getWebp.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await getWebp.arrayBuffer()).equals(VALID_WEBP)).toBe(true);

    // DELETE remove preview (204)
    const del = await fetch(`${api.base}/api/roompreview`, {
      method: 'DELETE',
      headers: { 'X-Lunio-Token': host.token },
    });
    expect(del.status).toBe(204);
    expect((await fetch(`${api.base}/api/rooms/PREVHTTP1/preview`)).status).toBe(404);
  });

  it('rejeita uploads não autorizados (401/403), tipo inválido (415), tamanho > 64KB (413), magic bytes inválidos (400), sala privada/trancada (403) e método inválido (405)', async () => {
    const host = await trackJoin('SECPREV1', { id: 'sh1', username: 'SecHost' }, { visibility: 'public' });
    const guest = await trackJoin('SECPREV1', { id: 'sg1', username: 'SecGuest' });
    const privHost = await trackJoin('SECPRIV1', { id: 'sph1', username: 'PrivHost' }, { visibility: 'private' });

    // Sem token -> 401
    expect(
      (
        await fetch(`${api.base}/api/roompreview`, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
          body: VALID_JPEG,
        })
      ).status
    ).toBe(401);

    // Token solo -> 403
    expect(
      (
        await fetch(`${api.base}/api/roompreview`, {
          method: 'PUT',
          headers: { 'X-Lunio-Token': soloToken, 'Content-Type': 'image/jpeg' },
          body: VALID_JPEG,
        })
      ).status
    ).toBe(403);

    // Espectador (não-Host) -> 403
    expect(
      (
        await fetch(`${api.base}/api/roompreview`, {
          method: 'PUT',
          headers: { 'X-Lunio-Token': guest.token, 'Content-Type': 'image/jpeg' },
          body: VALID_JPEG,
        })
      ).status
    ).toBe(403);

    // Sala privada -> 403
    expect(
      (
        await fetch(`${api.base}/api/roompreview`, {
          method: 'PUT',
          headers: { 'X-Lunio-Token': privHost.token, 'Content-Type': 'image/jpeg' },
          body: VALID_JPEG,
        })
      ).status
    ).toBe(403);
    expect((await fetch(`${api.base}/api/rooms/SECPRIV1/preview`)).status).toBe(404);

    // Content-Type inválido (SVG / HTML) -> 415
    expect(
      (
        await fetch(`${api.base}/api/roompreview`, {
          method: 'PUT',
          headers: { 'X-Lunio-Token': host.token, 'Content-Type': 'image/svg+xml' },
          body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        })
      ).status
    ).toBe(415);

    expect(
      (
        await fetch(`${api.base}/api/roompreview`, {
          method: 'PUT',
          headers: { 'X-Lunio-Token': host.token, 'Content-Type': 'text/html' },
          body: '<script>alert(1)</script>',
        })
      ).status
    ).toBe(415);

    // Payload > 65_536 bytes -> 413
    const oversized = Buffer.concat([VALID_JPEG, Buffer.alloc(65_537 - VALID_JPEG.length, 0x11)]);
    expect(oversized.length).toBe(65_537);
    expect(
      (
        await fetch(`${api.base}/api/roompreview`, {
          method: 'PUT',
          headers: { 'X-Lunio-Token': host.token, 'Content-Type': 'image/jpeg' },
          body: oversized,
        })
      ).status
    ).toBe(413);

    // Magic bytes inválidos (SVG disfarçado de JPEG / JPEG enviado como WebP) -> 400
    expect(
      (
        await fetch(`${api.base}/api/roompreview`, {
          method: 'PUT',
          headers: { 'X-Lunio-Token': host.token, 'Content-Type': 'image/jpeg' },
          body: Buffer.from('<svg>xss</svg>'),
        })
      ).status
    ).toBe(400);

    expect(
      (
        await fetch(`${api.base}/api/roompreview`, {
          method: 'PUT',
          headers: { 'X-Lunio-Token': host.token, 'Content-Type': 'image/webp' },
          body: VALID_JPEG,
        })
      ).status
    ).toBe(400);

    // Método não permitido -> 405
    expect(
      (
        await fetch(`${api.base}/api/roompreview`, {
          method: 'POST',
          headers: { 'X-Lunio-Token': host.token },
        })
      ).status
    ).toBe(405);

    // Código de sala inválido no GET preview -> 404
    expect((await fetch(`${api.base}/api/rooms/AB/preview`)).status).toBe(404);
    expect((await fetch(`${api.base}/api/rooms/NOT_VALID!/preview`)).status).toBe(404);

    // Sala trancada bloqueia PUT (403) e limpa preview existente (404)
    const okPut = await fetch(`${api.base}/api/roompreview`, {
      method: 'PUT',
      headers: { 'X-Lunio-Token': host.token, 'Content-Type': 'image/jpeg' },
      body: VALID_JPEG,
    });
    expect(okPut.status).toBe(200);
    await sendMsg(roomManager, host.socket, { type: 'room:settings', locked: true });
    expect((await fetch(`${api.base}/api/rooms/SECPREV1/preview`)).status).toBe(404);
    expect(
      (
        await fetch(`${api.base}/api/roompreview`, {
          method: 'PUT',
          headers: { 'X-Lunio-Token': host.token, 'Content-Type': 'image/jpeg' },
          body: VALID_JPEG,
        })
      ).status
    ).toBe(403);
  });
});
