import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFontNames } from '../media/fontNames';

const FONTS = path.resolve(process.cwd(), 'public', 'fonts');

describe('readFontNames', () => {
  it('lê família, nome completo e PostScript de uma TTF de verdade', () => {
    const names = readFontNames(fs.readFileSync(path.join(FONTS, 'trebucbd.ttf')));
    expect(names).toContain('trebuchet ms');
    expect(names).toContain('trebuchet ms bold');
    expect(names.every((n) => n === n.toLowerCase())).toBe(true);
  });

  it('cada estilo da família traz o seu nome completo', () => {
    const regular = readFontNames(fs.readFileSync(path.join(FONTS, 'trebuc.ttf')));
    const italic = readFontNames(fs.readFileSync(path.join(FONTS, 'trebucit.ttf')));
    expect(regular).toContain('trebuchet ms');
    expect(italic).toContain('trebuchet ms italic');
    expect(regular).not.toContain('trebuchet ms italic');
  });

  it('lê as fontes de uma coleção TTC', () => {
    // TTC mínima com duas entradas apontando para a mesma TTF (só o cabeçalho muda)
    const ttf = fs.readFileSync(path.join(FONTS, 'trebuc.ttf'));
    const header = Buffer.alloc(12 + 2 * 4);
    header.write('ttcf', 0, 'latin1');
    header.writeUInt32BE(0x00010000, 4);
    header.writeUInt32BE(2, 8);
    // Os offsets de tabela da TTF são relativos ao início do arquivo: realoca somando o tamanho do cabeçalho
    const shifted = Buffer.from(ttf);
    const numTables = shifted.readUInt16BE(4);
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      shifted.writeUInt32BE(shifted.readUInt32BE(rec + 8) + header.length, rec + 8);
    }
    header.writeUInt32BE(header.length, 12);
    header.writeUInt32BE(header.length, 16);
    const names = readFontNames(Buffer.concat([header, shifted]));
    expect(names).toContain('trebuchet ms');
  });

  it('arquivo estranho, truncado ou WOFF2 devolve vazio sem lançar', () => {
    expect(readFontNames(Buffer.alloc(0))).toEqual([]);
    expect(readFontNames(Buffer.from('wOF2....................'))).toEqual([]);
    expect(readFontNames(Buffer.from('lixo qualquer que não é fonte'))).toEqual([]);
    const ttf = fs.readFileSync(path.join(FONTS, 'trebuc.ttf'));
    expect(() => readFontNames(ttf.subarray(0, 300))).not.toThrow();
  });
});
