import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../config';
import { closeRedis, getRedisStatus, redisKeys, redisRetryStrategy, waitRedisReady, withRedis } from '../redis';
import { RedisUploadIndex } from '../uploadIndex';
import { RedisRoomStore, type PersistedRoom } from '../../roomStore';

/**
 * Contra um Redis DE VERDADE: roda só com `REDIS_TEST_URL` (no CI há um service container; localmente
 * `docker run -p 6379:6379 redis:8-alpine` e `REDIS_TEST_URL=redis://127.0.0.1:6379 npm test`).
 * Os testes de fallback (src/server/media/__tests__/redis.test.ts) usam uma porta morta e não pegam o que só aparece
 * com o servidor vivo: a espera de "pronto" depois de `connect()` e a reconexão depois de uma queda.
 * Cada teste usa ids aleatórios e apaga o que criou: pode apontar para um Redis compartilhado. O de queda de conexão
 * derruba as conexões de TODOS os clientes, então só roda com `REDIS_TEST_ALLOW_KILL=1` (o CI liga; um Redis em uso, não).
 */

const URL = process.env.REDIS_TEST_URL;
const rand = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

describe('redisRetryStrategy', () => {
  it('nunca desiste (null) e espera no máximo 5 s entre tentativas', () => {
    // Antes devolvia null depois de 3 tentativas: um `docker restart` do Redis deixava o Lunio só no disco para sempre
    for (const attempt of [1, 2, 3, 4, 10, 100, 10_000]) {
      const wait = redisRetryStrategy(attempt);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(5000);
    }
    expect(redisRetryStrategy(1)).toBeLessThan(redisRetryStrategy(5)); // cresce
  });
});

describe.skipIf(!URL)('com um Redis de verdade', () => {
  const created: string[] = [];
  const roots: string[] = [];
  let admin: Redis;

  beforeAll(() => {
    config.redisUrl = URL;
    admin = new Redis(URL!);
  });

  afterAll(async () => {
    if (created.length) await admin.del(...created);
    await admin.quit();
    closeRedis();
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  const keep = (...keys: string[]) => {
    created.push(...keys);
  };

  function makeUploadsDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-redis-real-'));
    roots.push(root);
    return root;
  }

  it('waitRedisReady espera a conexão que o getClient() acabou de começar', async () => {
    // O cliente nasce "connecting"; sem fila offline qualquer comando nesse instante falha ("Stream isn't writeable")
    void getRedisStatus();
    expect(await waitRedisReady(5000)).toBe(true);
    expect(await withRedis('caiu no disco', (r) => r.ping())).toBe('PONG');
    expect((await getRedisStatus()).connected).toBe(true);
  });

  it('rebuild logo depois de criar o cliente repõe as chaves: espera o "pronto" e grava o último uso do ARQUIVO', async () => {
    closeRedis(); // cliente NOVO, como na subida do servidor: ainda "connecting" quando o rebuild começa
    const root = makeUploadsDir();
    const id = rand();
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    const roomId = `R${rand().slice(0, 7)}`;
    fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify({ roomId, closedAt: 1234567, complete: true }));
    fs.writeFileSync(path.join(dir, 'video.mp4'), 'x');
    // A pasta é antiga (criada há 30 h); o arquivo foi lido há 10 min: o `mtime` da pasta não é o último uso
    const old = new Date(Date.now() - 30 * 3600_000);
    const recent = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(path.join(dir, 'video.mp4'), recent, recent);
    fs.utimesSync(dir, old, old);
    keep(redisKeys.lastRead(id), redisKeys.roomClosed(roomId), redisKeys.roomUploads(roomId));

    await new RedisUploadIndex().rebuild(root);

    const lastRead = Number(await admin.get(redisKeys.lastRead(id)));
    expect(lastRead).toBeGreaterThan(Date.now() - 11 * 60_000); // o arquivo, não a pasta de 30 h atrás
    expect(await admin.get(redisKeys.roomClosed(roomId))).toBe('1234567');
    expect(await admin.smembers(redisKeys.roomUploads(roomId))).toEqual([id]);
  });

  it('rebuild sem nenhum envio (pasta vazia ou inexistente) também conecta: o Status vê o Redis desde o arranque', async () => {
    closeRedis(); // servidor recém-subido: nenhum cliente ainda
    await new RedisUploadIndex().rebuild(path.join(os.tmpdir(), `lunio-nao-existe-${rand()}`));
    expect((await getRedisStatus()).connected).toBe(true);

    closeRedis();
    const empty = makeUploadsDir();
    await new RedisUploadIndex().rebuild(empty);
    expect((await getRedisStatus()).connected).toBe(true);
  });

  it('touch grava o último uso (com validade), lastRead devolve e forget apaga', async () => {
    const index = new RedisUploadIndex();
    const id = rand();
    keep(redisKeys.lastRead(id));
    const at = Date.now();

    expect(index.touch(id, at)).toBe(true);
    await expect.poll(() => admin.get(redisKeys.lastRead(id))).toBe(String(at));
    expect(await admin.pttl(redisKeys.lastRead(id))).toBeGreaterThan(47 * 3600_000); // 48 h

    expect(await index.lastRead(id)).toBe(at);
    index.forget(id);
    await expect.poll(() => admin.exists(redisKeys.lastRead(id))).toBe(0);
  });

  it('closeRoom e reopenRoom: um pipeline grava e apaga as chaves da sala de uma vez', async () => {
    const root = makeUploadsDir();
    const index = new RedisUploadIndex();
    const roomId = `S${rand().slice(0, 7)}`;
    const ids = [rand(), rand(), rand()];
    for (const id of ids) {
      fs.mkdirSync(path.join(root, id));
      fs.writeFileSync(path.join(root, id, '.meta.json'), JSON.stringify({ roomId, closedAt: null, complete: true }));
    }
    keep(redisKeys.roomClosed(roomId), redisKeys.roomUploads(roomId));

    index.closeRoom(roomId, 9_000_000, root);
    await expect.poll(() => admin.get(redisKeys.roomClosed(roomId))).toBe('9000000');
    expect((await admin.smembers(redisKeys.roomUploads(roomId))).sort()).toEqual([...ids].sort());
    expect(await admin.pttl(redisKeys.roomUploads(roomId))).toBeGreaterThan(0); // a validade também entrou

    index.reopenRoom(roomId, root);
    await expect.poll(() => admin.exists(redisKeys.roomClosed(roomId))).toBe(0);
  });

  it('RedisRoomStore: grava, lê de volta com validade, ignora lixo e remove', async () => {
    const store = new RedisRoomStore();
    const mk = (): PersistedRoom => ({
      v: 1, roomId: `T${rand().slice(0, 10)}`, hostId: 'h', media: null, playlist: [], bans: [],
      playback: { playing: false, position: 7, rate: 1 }, savedAt: Date.now(),
    });
    // Mais que o COUNT do SCAN (200) para provar que a varredura percorre o cursor inteiro
    const rooms = Array.from({ length: 230 }, mk);
    for (const r of rooms) keep(redisKeys.roomState(r.roomId));
    await Promise.all(rooms.map((r) => store.save(r)));
    const junk = `J${rand().slice(0, 10)}`;
    keep(redisKeys.roomState(junk));
    await admin.set(redisKeys.roomState(junk), '{nao e json');

    expect(await admin.pttl(redisKeys.roomState(rooms[0].roomId))).toBeGreaterThan(config.roomStateTtlMs - 60_000);

    const loaded = await store.loadAll();
    const ids = new Set(loaded.rooms.map((r) => r.roomId));
    expect(rooms.every((r) => ids.has(r.roomId))).toBe(true);
    expect(ids.has(junk)).toBe(false);

    await store.remove(rooms[0].roomId);
    expect(await admin.exists(redisKeys.roomState(rooms[0].roomId))).toBe(0);
  });

  it.skipIf(!process.env.REDIS_TEST_ALLOW_KILL)('depois de uma queda da conexão o cliente volta sozinho (e os comandos voltam a funcionar)', async () => {
    expect(await waitRedisReady(5000)).toBe(true);
    // Derruba as conexões "normais" de todo mundo menos a do admin: o cliente do Lunio vê a queda e reconecta
    await admin.call('CLIENT', 'KILL', 'TYPE', 'normal', 'SKIPME', 'yes');
    await expect.poll(async () => (await getRedisStatus()).connected, { timeout: 8000 }).toBe(true);
    expect(await withRedis('caiu no disco', (r) => r.ping())).toBe('PONG');
  });
});
