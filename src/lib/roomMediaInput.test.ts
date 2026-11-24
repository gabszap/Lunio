import { describe, it, expect, vi } from 'vitest';
import { formatRoomDuration } from './roomDuration';
import { prepareMediaLink } from './roomMediaInput';

describe('formatRoomDuration', () => {
  it('formata abaixo de 1 hora como MM:SS e acima como HH:MM:SS', () => {
    expect(formatRoomDuration(-5000)).toBe('00:00');
    expect(formatRoomDuration(0)).toBe('00:00');
    expect(formatRoomDuration(65_000)).toBe('01:05');
    expect(formatRoomDuration(3_661_000)).toBe('01:01:01');
  });
});

describe('prepareMediaLink', () => {
  it('rejeita URL inválida, lista cheia e duplicado ignorando fragmento', async () => {
    expect(await prepareMediaLink('nao-e-url', [], 50)).toMatchObject({ ok: false });
    expect(await prepareMediaLink('https://a.com/v.mp4', ['https://a.com/v.mp4#t=10'], 50)).toMatchObject({ ok: false });
    expect(await prepareMediaLink('https://a.com/v.mp4', Array(2).fill('https://x.com/1.mp4'), 2)).toMatchObject({ ok: false });
  });

  it('normaliza link do YouTube e usa oEmbed quando disponível', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: 'Episódio 1' }),
    }) as unknown as typeof fetch;
    const res = await prepareMediaLink('https://youtu.be/dQw4w9WgXcQ', [], 50, fakeFetch);
    expect(res).toEqual({
      ok: true,
      item: {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Episódio 1',
        mimeType: 'video/youtube',
      },
    });
  });

  it('usa título genérico para YouTube quando oEmbed falha', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const res = await prepareMediaLink('https://youtu.be/dQw4w9WgXcQ', [], 50, fakeFetch);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.item.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(res.item.mimeType).toBe('video/youtube');
      expect(res.item.title.length).toBeGreaterThan(0);
    }
  });

  it('prepara link direto de stream com título limpo e mimeType', async () => {
    const res = await prepareMediaLink('https://cdn.example/Anime.S01E01.mkv', [], 50);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.item.url).toBe('https://cdn.example/Anime.S01E01.mkv');
      expect(res.item.title).toContain('Anime');
      expect(res.item.mimeType).toBeTruthy();
    }
  });
});
