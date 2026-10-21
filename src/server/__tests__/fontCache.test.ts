import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-fontcache-'));
const FONTS = path.join(ROOT, 'fonts');

// A pasta de fontes do teste é uma pasta temporária: não mexe no `.cache/` de verdade
vi.mock('../media/paths', () => ({ FONT_CACHE_DIR: FONTS, SUB_CACHE_DIR: ROOT, AUDIO_CACHE_DIR: ROOT, HLS_CACHE_DIR: ROOT }));

const { indexFonts, readNamesIndex, SHARED_DIR_NAME } = await import('../media/fontCache');
const { sweepCache } = await import('../cleanup');

const SRC = path.resolve(process.cwd(), 'public', 'fonts');
const copyFont = (from: string, mediaDir: string, idx: number) => {
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.copyFileSync(path.join(SRC, from), path.join(mediaDir, `f${idx}.ttf`));
};
const ino = (f: string) => fs.statSync(f).ino;

beforeAll(() => fs.mkdirSync(FONTS, { recursive: true }));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('fontCache.indexFonts', () => {
  it('grava os nomes de cada fonte em names.json', () => {
    const dir = path.join(FONTS, 'midia-1');
    copyFont('trebuc.ttf', dir, 3);
    copyFont('trebucbd.ttf', dir, 4);
    const index = indexFonts(dir);
    expect(index['3'].names).toContain('trebuchet ms');
    expect(index['4'].names).toContain('trebuchet ms bold');
    expect(readNamesIndex(dir)).toEqual(index); // gravado em disco
  });

  it('episódios com as mesmas fontes guardam um arquivo só (hardlink), e cada pasta continua lendo f<índice>.ttf', () => {
    const a = path.join(FONTS, 'ep-a');
    const b = path.join(FONTS, 'ep-b');
    copyFont('trebuc.ttf', a, 0);
    copyFont('trebuc.ttf', b, 7); // índices diferentes, mesmo conteúdo
    indexFonts(a);
    indexFonts(b);
    expect(ino(path.join(a, 'f0.ttf'))).toBe(ino(path.join(b, 'f7.ttf')));
    expect(fs.readFileSync(path.join(a, 'f0.ttf')).equals(fs.readFileSync(path.join(SRC, 'trebuc.ttf')))).toBe(true);
    // o compartilhado guarda uma cópia por conteúdo
    const shared = fs.readdirSync(path.join(FONTS, SHARED_DIR_NAME));
    expect(shared.filter((n) => n.endsWith('.ttf')).length).toBe(new Set(shared).size);
  });

  it('apagar a pasta de um episódio não estraga o outro', () => {
    const a = path.join(FONTS, 'ep-c');
    const b = path.join(FONTS, 'ep-d');
    copyFont('trebucit.ttf', a, 1);
    copyFont('trebucit.ttf', b, 1);
    indexFonts(a);
    indexFonts(b);
    fs.rmSync(a, { recursive: true, force: true });
    expect(fs.readFileSync(path.join(b, 'f1.ttf')).length).toBe(fs.statSync(path.join(SRC, 'trebucit.ttf')).size);
  });

  it('indexar de novo não relê nem refaz o que já está indexado', () => {
    const dir = path.join(FONTS, 'midia-2');
    copyFont('trebuc.ttf', dir, 0);
    indexFonts(dir);
    const before = fs.statSync(path.join(dir, 'names.json')).mtimeMs;
    const again = indexFonts(dir);
    expect(again['0'].names.length).toBeGreaterThan(0);
    expect(fs.statSync(path.join(dir, 'names.json')).mtimeMs).toBe(before);
  });

  it('fonte que não é TTF/OTF fica com nomes vazios (o player a carrega por garantia)', () => {
    const dir = path.join(FONTS, 'midia-3');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'f2.woff2'), Buffer.alloc(500, 7));
    expect(indexFonts(dir)['2']).toEqual({ names: [], ext: 'woff2' });
  });
});

describe('cache: hardlinks contam uma vez só', () => {
  it('o mesmo arquivo em várias pastas não faz o cache parecer maior que o limite', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-sweep-'));
    try {
      const file = path.join(root, 'fonts', '_shared', 'x.ttf');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.alloc(10_000, 1));
      for (const m of ['m1', 'm2', 'm3']) {
        fs.mkdirSync(path.join(root, 'fonts', m));
        fs.linkSync(file, path.join(root, 'fonts', m, 'f0.ttf'));
      }
      const old = new Date(Date.now() - 3600_000);
      for (const p of [file, ...['m1', 'm2', 'm3'].map((m) => path.join(root, 'fonts', m, 'f0.ttf'))]) fs.utimesSync(p, old, old);
      for (const d of ['_shared', 'm1', 'm2', 'm3']) fs.utimesSync(path.join(root, 'fonts', d), old, old);

      // 4 nomes, 10 KB reais: com limite de 15 KB nada deve sair (somando os links seriam 40 KB)
      expect(sweepCache(Date.now(), root, {}, 15_000)).toBe(0);
      // com limite abaixo do tamanho real, sai
      expect(sweepCache(Date.now(), root, {}, 5_000)).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
