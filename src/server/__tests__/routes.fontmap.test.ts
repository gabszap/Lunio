import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.SESSION_SECRET = 'segredo-de-teste';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-fontmap-'));
const FONTS = path.join(ROOT, 'fonts');
vi.mock('../media/paths', () => ({ FONT_CACHE_DIR: FONTS, SUB_CACHE_DIR: ROOT, AUDIO_CACHE_DIR: ROOT, HLS_CACHE_DIR: ROOT }));

const { startApi } = await import('./helpers');
const { createApiRouter } = await import('../app');
const { tracksCache } = await import('../media/tracks');
const { getMediaFingerprint } = await import('../media/fingerprint');
const { indexFonts } = await import('../media/fontCache');

const SRC = path.resolve(process.cwd(), 'public', 'fonts');
const trackInfo = (fonts: Array<{ index: number; filename: string }>) =>
  ({ title: 't', rawTitle: 't', duration: 3, parsedTorrent: null, audios: [], chapters: [], subtitles: [], fonts, streamUrl: '' }) as any;

/** GET /api/fontmap: nomes pelos quais cada fonte anexada pode ser pedida por uma legenda. */
describe('GET /api/fontmap', () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  let token: string;
  const ask = (url: string, fingerprint: string) =>
    fetch(`${api.base}/api/fontmap?url=${encodeURIComponent(url)}&fingerprint=${encodeURIComponent(fingerprint)}`, { headers: { 'X-Lunio-Token': token } });

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(FONTS, { recursive: true });
    api = await startApi(createApiRouter);
    token = ((await (await fetch(`${api.base}/api/session`, { method: 'POST' })).json()) as { token: string }).token;
  });
  afterAll(async () => {
    await api?.close();
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('exige o token de sessão e a url', async () => {
    expect((await fetch(`${api.base}/api/fontmap?url=${encodeURIComponent('http://x.test/a.mkv')}`)).status).toBe(401);
    expect((await fetch(`${api.base}/api/fontmap`, { headers: { 'X-Lunio-Token': token } })).status).toBe(400);
  });

  it('faixas ainda não listadas: complete false (o player carrega todas as fontes)', async () => {
    const body = (await (await ask('http://x.test/nunca-listado.mkv', 'fp-nunca')).json()) as any;
    expect(body).toEqual({ complete: false, fonts: {} });
  });

  it('arquivo sem fontes anexadas: complete true e mapa vazio', async () => {
    tracksCache.set('http://x.test/sem-fontes.mkv', trackInfo([]));
    const body = (await (await ask('http://x.test/sem-fontes.mkv', 'fp-sem')).json()) as any;
    expect(body).toEqual({ complete: true, fonts: {} });
  });

  it('devolve os nomes de cada fonte já extraída; a que não tem entrada vem null', async () => {
    const url = 'http://x.test/com-fontes.mkv';
    const fp = 'fp-com';
    tracksCache.set(url, trackInfo([{ index: 5, filename: 'a.ttf' }, { index: 6, filename: 'b.ttf' }]));
    const dir = path.join(FONTS, getMediaFingerprint(url, fp));
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(SRC, 'trebuc.ttf'), path.join(dir, 'f5.ttf'));
    indexFonts(dir);
    fs.writeFileSync(path.join(dir, 'f6.done'), 'x'); // 6 já foi tentada e falhou: não extrai de novo, fica sem nomes

    const body = (await (await ask(url, fp)).json()) as any;
    expect(body.complete).toBe(true);
    expect(body.fonts['5']).toContain('trebuchet ms');
    expect(body.fonts['6']).toBeNull();
  });
});
