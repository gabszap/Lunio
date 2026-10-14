import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapAttachmentOrdinals, placeAttachments, type AttachmentEntry } from '../media/attachments';

const entries = (names: string[]): AttachmentEntry[] => names.map((filename, ordinal) => ({ ordinal, filename, size: 10 }));

describe('mapAttachmentOrdinals', () => {
  const list = entries(['arial.ttf', 'arialbd.ttf', 'impact.ttf']);

  it('casa o índice do FFmpeg com a ordem do anexo (índice - menor índice de anexo)', () => {
    const wanted = new Map([['5', 'arialbd.ttf'], ['6', 'impact.ttf']]);
    const m = mapAttachmentOrdinals(wanted, [4, 5, 6], list);
    expect([...m]).toEqual([['5', 1], ['6', 2]]);
  });

  it('deixa de fora o que o nome não confirma (o FFmpeg cobre)', () => {
    const wanted = new Map([['4', 'outra.ttf'], ['5', 'arialbd.ttf']]);
    const m = mapAttachmentOrdinals(wanted, [4, 5, 6], list);
    expect([...m]).toEqual([['5', 1]]);
  });

  it('índice além da lista não casa', () => {
    expect(mapAttachmentOrdinals(new Map([['9', '']]), [4, 5, 6], list).size).toBe(0);
  });

  it('sem a lista do /api/tracks só o nome único decide', () => {
    const dup = entries(['a.ttf', 'b.ttf', 'a.ttf']);
    const m = mapAttachmentOrdinals(new Map([['7', 'b.ttf'], ['8', 'a.ttf']]), [], dup);
    expect([...m]).toEqual([['7', 1]]);
  });
});

describe('placeAttachments', () => {
  it('renomeia os pedidos para o nome do servidor e apaga o resto', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-att-'));
    try {
      for (const n of [0, 1, 2]) fs.writeFileSync(path.join(dir, `a${n}.bin`), `font${n}`);
      placeAttachments(dir, entries(['a', 'b', 'c']), new Map([[1, 'f5.ttf']]));
      expect(fs.readdirSync(dir)).toEqual(['f5.ttf']);
      expect(fs.readFileSync(path.join(dir, 'f5.ttf'), 'utf8')).toBe('font1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
