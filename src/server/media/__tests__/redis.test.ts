import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../config';
import { getRedisStatus, redisKeys, withRedis } from '../redis';
import { RedisUploadIndex, uploadIndex } from '../uploadIndex';

const originalRedisUrl = config.redisUrl;

afterAll(() => {
  config.redisUrl = originalRedisUrl;
});

describe('sem REDIS_URL', () => {
  it('não há cliente e o índice é o de memória', async () => {
    config.redisUrl = undefined;
    expect(await getRedisStatus()).toEqual({ enabled: false, connected: false });
    expect(uploadIndex).toBeInstanceOf(Object);
    expect((uploadIndex as object).constructor.name).toBe('MemoryUploadIndex');
  });
});

describe('com REDIS_URL (o sistema cai no disco quando o Redis não responde)', () => {
  beforeAll(() => {
    config.redisUrl = 'redis://127.0.0.1:1'; // porta reservada: toda tentativa de conexão falha
  });

  it('withRedis devolve o fallback quando o Redis falha ou não responde no teto, e o Status mostra índice habilitado', async () => {
    const value = await withRedis('cade o disco', async (r) => `redis disse ${await r.get('nada')}`);
    expect(value).toBe('cade o disco'); // caiu no fallback (conexão recusada)
    const hung = await withRedis('a', () => new Promise<string>(() => {})); // sem resposta: o teto de 300 ms decide
    expect(hung).toBe('a');
    expect((await getRedisStatus()).enabled).toBe(true);
  }, 2_000);

  it('índice com Redis funciona do mesmo jeito com o Redis morto (closeRoom grava só no disco)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-redis-'));
    const index = new RedisUploadIndex();
    const metaPath = path.join(root, 'ab12cd34ef567890', '.meta.json');
    fs.mkdirSync(path.dirname(metaPath));
    fs.writeFileSync(metaPath, JSON.stringify({ roomId: 'SALA1', closedAt: null }));

    index.closeRoom('SALA1', 555, root);
    await new Promise((r) => setTimeout(r, 50)); // deixa as chamadas mortas do Redis vencerem

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.closedAt).toBe(555); // o disco, que é a verdade, continuou certo
    expect(await index.lastRead('ab12cd34ef567890')).toBeUndefined(); // cai no mtime e sobe para a limpeza
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('as chaves têm o prefixo decidido', () => {
    expect(redisKeys.lastRead('ab')).toBe('lunio:up:ab:read');
    expect(redisKeys.roomUploads('S1')).toBe('lunio:up:room:S1');
    expect(redisKeys.roomClosed('S1')).toBe('lunio:room:closed:S1');
  });
});
