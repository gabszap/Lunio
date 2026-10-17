import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCacheStats, sweepCache, sweepUploads } from '../cleanup';
import { pruneRoomUploads, UPLOAD_META, uploadIdFromUrl, uploadsInProgress } from '../media/uploads';
import { roomManager } from '../roomServer';

const HOUR = 3_600_000;
const roots: string[] = [];

afterEach(() => {
  uploadsInProgress.clear();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function makeUploads() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-up-'));
  roots.push(root);
  return root;
}

/** Cria `<root>/<id>/video.mp4` do tamanho dado, da sala dada, "usado" há `ageMs`. */
function put(root: string, id: string, roomId: string, ageMs = 0) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'video.mp4'), Buffer.alloc(50, 1));
  fs.writeFileSync(path.join(dir, UPLOAD_META), JSON.stringify({ roomId, name: 'video.mp4', createdAt: Date.now() - ageMs }));
  const when = new Date(Date.now() - ageMs);
  for (const f of [path.join(dir, 'video.mp4'), path.join(dir, UPLOAD_META), dir]) fs.utimesSync(f, when, when);
  return dir;
}

const id = (n: number) => n.toString(16).padStart(16, '0');

describe('uploadIdFromUrl', () => {
  it('lê o id de um link de envio (com ou sem token) e ignora o resto', () => {
    expect(uploadIdFromUrl('/api/uploads/0123456789abcdef/video.mp4')).toBe('0123456789abcdef');
    expect(uploadIdFromUrl('https://lunio.stream/api/uploads/0123456789abcdef/a%20b.mkv?token=x')).toBe('0123456789abcdef');
    expect(uploadIdFromUrl('https://exemplo.test/video.mkv')).toBeNull();
    expect(uploadIdFromUrl('/api/uploads/curto/video.mp4')).toBeNull();
  });
});

describe('pruneRoomUploads: uma sala, um envio', () => {
  it('apaga os outros envios da sala e preserva o que está em uso, os de outras salas e os em andamento', () => {
    const root = makeUploads();
    put(root, id(1), 'SALA1');
    put(root, id(2), 'SALA1');
    put(root, id(3), 'SALA1');
    put(root, id(4), 'OUTRA');
    uploadsInProgress.add(id(3));

    const removed = pruneRoomUploads('SALA1', new Set([id(1)]), root);

    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(root, id(1)))).toBe(true); // em uso
    expect(fs.existsSync(path.join(root, id(2)))).toBe(false); // sobra da sala
    expect(fs.existsSync(path.join(root, id(3)))).toBe(true); // ainda chegando
    expect(fs.existsSync(path.join(root, id(4)))).toBe(true); // de outra sala
  });

  it('ignora pastas que não são envios (nome fora do padrão ou sem metadados)', () => {
    const root = makeUploads();
    fs.mkdirSync(path.join(root, 'qualquer-coisa'));
    fs.mkdirSync(path.join(root, id(9)));
    expect(pruneRoomUploads('SALA1', new Set(), root)).toBe(0);
    expect(fs.readdirSync(root).sort()).toEqual([id(9), 'qualquer-coisa'].sort());
  });
});

describe('sweepUploads: validade por último uso', () => {
  it('sala aberta: sai só se ninguém lê há mais que o prazo; lido recentemente fica', () => {
    const root = makeUploads();
    roomManager.getOrCreateRoom('ABERTA1'); // sala ativa
    put(root, id(1), 'ABERTA1', 30 * HOUR); // sem leitura há 30 h
    put(root, id(2), 'ABERTA1', 2 * HOUR); // lido há 2 h

    const removed = sweepUploads(Date.now(), root, 6 * HOUR, 24 * HOUR);

    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(root, id(1)))).toBe(false);
    expect(fs.existsSync(path.join(root, id(2)))).toBe(true);
  });

  it('sala encerrada: só sai depois do prazo pós-fechamento', () => {
    const root = makeUploads();
    put(root, id(1), 'ENCERRADA1', 30 * HOUR);
    // Servidor "acabou de subir": o prazo de 6 h conta do início do processo, então agora ainda não vence...
    expect(sweepUploads(Date.now(), root, 6 * HOUR, 24 * HOUR)).toBe(0);
    // ...e 7 h depois sim.
    expect(sweepUploads(Date.now() + 7 * HOUR, root, 6 * HOUR, 24 * HOUR)).toBe(1);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('o relatório da limpeza conta o que saiu dos envios e do cache, e soma desde o início do servidor', () => {
    const uploads = makeUploads();
    const cacheRoot = makeUploads();
    sweepCache(Date.now(), cacheRoot); // fecha a rodada dos testes anteriores, que também chamaram sweepUploads
    roomManager.getOrCreateRoom('RELATORIO1');
    put(uploads, id(1), 'RELATORIO1', 30 * HOUR); // sem leitura há 30 h: sai
    put(uploads, id(2), 'RELATORIO1', 1 * HOUR); // fica

    const before = getCacheStats().totals;
    expect(sweepUploads(Date.now(), uploads, 6 * HOUR, 24 * HOUR)).toBe(1);
    // A passada do cache fecha o relatório da rodada (é assim que a limpeza roda: envios e depois cache)
    sweepCache(Date.now(), cacheRoot);

    const stats = getCacheStats(Date.now());
    expect(stats.lastSweep).toMatchObject({ uploads: 1, byAge: 0, byLimit: 0 });
    expect(stats.lastSweep!.freedBytes).toBeGreaterThanOrEqual(50); // o arquivo do envio removido
    expect(stats.totals.items).toBe(before.items + 1);
    expect(stats.totals.bytes).toBeGreaterThanOrEqual(before.bytes + 50);

    // A rodada seguinte, sem nada para remover, zera o "desta passada" mas mantém o total
    sweepCache(Date.now(), cacheRoot);
    const next = getCacheStats(Date.now());
    expect(next.lastSweep).toMatchObject({ uploads: 0, freedBytes: 0 });
    expect(next.totals.items).toBe(before.items + 1);
  });
});
