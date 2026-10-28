import { describe, expect, it } from 'vitest';
import { isExemptFromOpaque, isLinkId, linkIdFor, linksOf, resolveLinkId, scrubFor, type LinkRoom } from '../links';

const KEY = 'https://api.exemplo.com/v1/dl?token=SEGREDO-DO-HOST&file=9';
const OTHER = 'https://cdn.exemplo.com/f/CHAVE-DE-ALGUEM/Anime%20-%2002.mkv';

const room = (over: Partial<LinkRoom> = {}): LinkRoom => ({
  roomId: 'sala1',
  media: { url: KEY, ownerId: 'host1' },
  playlist: [{ url: OTHER, addedById: 'ana' }],
  ...over,
});

describe('links opacos', () => {
  it('o id é estável na sala, muda de sala e não deixa ver o link', () => {
    const id = linkIdFor('sala1', KEY);
    expect(isLinkId(id)).toBe(true);
    expect(linkIdFor('sala1', KEY)).toBe(id);
    expect(linkIdFor('sala1', `${KEY}#frag`)).toBe(id); // o #fragmento não conta (mesma regra da fila)
    expect(linkIdFor('sala2', KEY)).not.toBe(id);
    expect(id).not.toContain('SEGREDO');
  });

  it('isLinkId só aceita o formato exato', () => {
    expect(isLinkId('lk_' + 'a'.repeat(22))).toBe(true);
    expect(isLinkId('lk_' + 'a'.repeat(21))).toBe(false);
    expect(isLinkId('https://x/y')).toBe(false);
    expect(isLinkId(undefined)).toBe(false);
  });

  it('linksOf junta mídia e fila, sem repetir, e deixa de fora envios e YouTube', () => {
    const upload = 'http://127.0.0.1:3000/api/uploads/0123456789abcdef/video.mkv?t=x';
    const r = room({
      playlist: [
        { url: KEY, addedById: 'ana' }, // o mesmo link da mídia
        { url: OTHER, addedById: 'ana' },
        { url: upload, addedById: 'ana' },
        { url: 'https://www.youtube.com/watch?v=abcdefghijk', addedById: 'ana' },
      ],
    });
    const entries = linksOf(r);
    expect(entries.map((e) => e.url)).toEqual([KEY, OTHER]);
    expect(entries[0].ownerId).toBe('host1'); // o primeiro dono (a mídia) vale
    expect(isExemptFromOpaque(upload)).toBe(true);
    expect(isExemptFromOpaque('https://youtu.be/abcdefghijk')).toBe(true);
    expect(isExemptFromOpaque(KEY)).toBe(false);
  });

  it('resolveLinkId só acha ids da própria sala', () => {
    const r = room();
    const id = linkIdFor('sala1', OTHER);
    expect(resolveLinkId(r, id)).toMatchObject({ url: OTHER, ownerId: 'ana' });
    expect(resolveLinkId(room({ roomId: 'sala2' }), id)).toBeNull(); // id de outra sala
    expect(resolveLinkId(r, 'lk_' + 'x'.repeat(22))).toBeNull();
    expect(resolveLinkId(r, KEY)).toBeNull(); // link cru não é id
  });

  it('scrubFor esconde o link de quem não o enviou, nas duas formas, e deixa o dono ver', () => {
    const entries = linksOf(room());
    const idKey = linkIdFor('sala1', KEY);
    const idOther = linkIdFor('sala1', OTHER);
    const msg = JSON.stringify({
      media: { url: KEY, subtitles: [{ url: `/api/subtitle?url=${encodeURIComponent(KEY)}&track=2` }] },
      playlist: [{ url: OTHER }],
    });

    const spectator = scrubFor(entries, 'bia', msg);
    expect(spectator).not.toContain('SEGREDO');
    expect(spectator).not.toContain('CHAVE-DE-ALGUEM');
    expect(spectator).toContain(`"url":"${idKey}"`);
    expect(spectator).toContain(`/api/subtitle?url=${idKey}&track=2`);
    expect(spectator).toContain(`"url":"${idOther}"`);

    const host = scrubFor(entries, 'host1', msg);
    expect(host).toContain('SEGREDO'); // o dono vê o próprio
    expect(host).not.toContain('CHAVE-DE-ALGUEM'); // mas não o da Ana
    expect(scrubFor(entries, 'ana', msg)).toContain('CHAVE-DE-ALGUEM');
    expect(scrubFor(entries, 'host1_tab0001', msg)).toContain('SEGREDO'); // a segunda aba é a mesma pessoa
  });

  it('scrubFor acerta link com aspas ou barra invertida (escapados no JSON)', () => {
    const odd = 'https://x.test/a"b\c?token=SEGREDO';
    const entries = linksOf({ roomId: 's', media: { url: odd, ownerId: 'h' }, playlist: [] });
    const out = scrubFor(entries, 'bia', JSON.stringify({ url: odd }));
    expect(out).not.toContain('SEGREDO');
  });
});
