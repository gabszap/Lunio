import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BoundedCache } from '../cache';
import { onCacheUnitRemoved, sweepCache } from '../cleanup';

describe('BoundedCache', () => {
  it('passou do teto, sai quem foi usado há mais tempo (ler conta como uso)', () => {
    const c = new BoundedCache<number>(3, 60_000);
    c.set('a', 1).set('b', 2).set('c', 3);
    c.get('a'); // a vira o mais recente
    c.set('d', 4);
    expect(c.has('b')).toBe(false);
    expect([c.has('a'), c.has('c'), c.has('d')]).toEqual([true, true, true]);
    expect(c.size).toBe(3);
  });

  it('entrada sem uso além da validade some; usar renova', () => {
    let now = 1_000;
    const c = new BoundedCache<string>(10, 100, () => now);
    c.set('a', 'x');
    c.set('b', 'y');
    now += 80;
    expect(c.get('a')).toBe('x'); // renova a
    now += 80; // b passou de 100 sem uso; a só 80
    expect(c.get('b')).toBeUndefined();
    expect(c.has('b')).toBe(false);
    expect(c.get('a')).toBe('x');
    now += 200;
    expect(c.get('a')).toBeUndefined();
  });

  it('set também varre as expiradas, para não guardar lixo até alguém pedir', () => {
    let now = 0;
    const c = new BoundedCache<number>(10, 100, () => now);
    c.set('velha', 1);
    now += 500;
    c.set('nova', 2);
    expect(c.size).toBe(1);
  });

  it('deleteWhere remove só o que casa', () => {
    const c = new BoundedCache<{ dir: string }>(10, 60_000);
    c.set('1', { dir: '/a' }).set('2', { dir: '/b' });
    expect(c.deleteWhere((_k, v) => v.dir === '/a')).toBe(1);
    expect(c.has('1')).toBe(false);
    expect(c.has('2')).toBe(true);
  });
});

describe('sweepCache: idade por tipo e limite de tamanho', () => {
  const roots: string[] = [];
  const HOUR = 3_600_000;
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

  function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-cache-'));
    roots.push(root);
    for (const g of ['subtitles', 'fonts', 'hls', 'audio']) fs.mkdirSync(path.join(root, g));
    return root;
  }
  /** Cria um arquivo e o "usa" há `ageMs` (o mtime é o que o LRU e a idade consultam). */
  function put(file: string, bytes: number, ageMs: number) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
    const when = new Date(NOW - ageMs);
    fs.utimesSync(file, when, when);
    // A pasta da mídia também conta no "último uso": envelhece junto (criar o arquivo a deixou com a hora de agora)
    fs.utimesSync(path.dirname(file), when, when);
  }
  // Prazos fixos do teste (os padrões de verdade ficam em config.ts)
  const ages = { subtitles: 24 * HOUR, fonts: 7 * 24 * HOUR, hls: 24 * HOUR, audio: 24 * HOUR };

  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  it('legendas e HLS passam de 24 h; fontes só de 7 dias; o que está dentro do prazo fica', () => {
    const root = makeRoot();
    put(path.join(root, 'subtitles', 'velha_s3.ass'), 100, 25 * HOUR);
    put(path.join(root, 'subtitles', 'nova_s3.ass'), 100, 2 * HOUR);
    put(path.join(root, 'fonts', 'midia1', 'f1.ttf'), 100, 3 * 24 * HOUR); // 3 dias: fonte fica
    put(path.join(root, 'fonts', 'midia2', 'f1.ttf'), 100, 8 * 24 * HOUR); // 8 dias: sai
    put(path.join(root, 'hls', 'm1', '0.ts'), 100, 30 * HOUR);
    put(path.join(root, 'hls', 'm2', '0.ts'), 100, 1 * HOUR);

    const removed = sweepCache(NOW, root, ages, 10 ** 9);

    expect(removed).toBe(3);
    expect(fs.existsSync(path.join(root, 'subtitles', 'velha_s3.ass'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'subtitles', 'nova_s3.ass'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'fonts', 'midia1'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'fonts', 'midia2'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'hls', 'm1'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'hls', 'm2'))).toBe(true);
  });

  it('uma pasta de mídia vale pelo arquivo mais recente dentro dela (usar uma fonte protege as outras)', () => {
    const root = makeRoot();
    put(path.join(root, 'fonts', 'midia', 'f1.ttf'), 100, 20 * 24 * HOUR);
    put(path.join(root, 'fonts', 'midia', 'f2.ttf'), 100, 1 * HOUR);
    expect(sweepCache(NOW, root, ages, 10 ** 9)).toBe(0);
    expect(fs.readdirSync(path.join(root, 'fonts', 'midia'))).toHaveLength(2);
  });

  it('ainda acima do limite: sai o menos usado primeiro, só até caber', () => {
    const root = makeRoot();
    put(path.join(root, 'subtitles', 'a_s1.ass'), 400, 5 * HOUR);
    put(path.join(root, 'subtitles', 'b_s1.ass'), 400, 3 * HOUR);
    put(path.join(root, 'subtitles', 'c_s1.ass'), 400, 1 * HOUR);
    expect(sweepCache(NOW, root, ages, 900)).toBe(1); // 1200 → 800
    expect(fs.existsSync(path.join(root, 'subtitles', 'a_s1.ass'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'subtitles', 'b_s1.ass'))).toBe(true);
  });

  it('não apaga o que foi mexido há menos de 2 min, mesmo acima do limite', () => {
    const root = makeRoot();
    put(path.join(root, 'subtitles', 'gravando_s1.ass'), 400, 30_000);
    expect(sweepCache(NOW, root, ages, 100)).toBe(0);
  });

  it('avisa quem registrou interesse em cada unidade removida', () => {
    const root = makeRoot();
    put(path.join(root, 'hls', 'm1', '0.ts'), 10, 40 * HOUR);
    const seen: string[] = [];
    onCacheUnitRemoved((p) => seen.push(p));
    sweepCache(NOW, root, ages, 10 ** 9);
    expect(seen).toEqual([path.join(root, 'hls', 'm1')]);
  });
});
