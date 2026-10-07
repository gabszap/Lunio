import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasBinary } from './helpers';

// Aqui o proxy PRECISA alcançar 127.0.0.1 (servidor de fixture local), então a rede privada é liberada.
// A cobertura do bloqueio (padrão de produção) está em routes.security.test.ts.
process.env.ALLOW_PRIVATE_URLS = '1';
process.env.SESSION_SECRET = 'segredo-de-teste';

const ffmpegOk = hasBinary(process.env.FFMPEG_PATH || 'ffmpeg');
const pythonOk = hasBinary('python3', ['--version']) || hasBinary('python', ['--version']);
const CACHE = path.resolve(process.cwd(), '.cache');

const ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:02.50,Default,,0,0,0,,Legenda de teste do Lunio
`;

const json = async (res: Response) => res.json() as Promise<any>;

describe.skipIf(!ffmpegOk)('rotas de mídia (FFmpeg)', () => {
  let tmp: string;
  let fixture: { base: string; close(): Promise<void> };
  let api: { base: string; close(): Promise<void> };
  let token: string;
  let mediaUrl: string;
  let tracksCache: typeof import('../media/tracks').tracksCache;
  const cacheBefore = new Set<string>();
  const listCache = () =>
    ['subtitles', 'fonts'].flatMap((d) => {
      try {
        return fs.readdirSync(path.join(CACHE, d)).map((f) => path.join(CACHE, d, f));
      } catch {
        return [];
      }
    });
  const h = () => ({ headers: { 'X-Lunio-Token': token } });

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const f of listCache()) cacheBefore.add(f);

    // MKV de 3 s: vídeo + 2 áudios (jpn/por) + legenda ASS + um anexo "fonte"
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-media-'));
    fs.writeFileSync(path.join(tmp, 'sub.ass'), ASS);
    fs.writeFileSync(path.join(tmp, 'fonte.ttf'), Buffer.alloc(4096, 1));
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const made = spawnSync(
      ffmpeg,
      [
        '-hide_banner', '-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=3:size=160x90:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3',
        '-i', path.join(tmp, 'sub.ass'),
        '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'ass',
        '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=por', '-metadata:s:s:0', 'language=por',
        '-attach', path.join(tmp, 'fonte.ttf'), '-metadata:s:t', 'mimetype=font/ttf', '-metadata:s:t', 'filename=fonte.ttf',
        path.join(tmp, 'teste.mkv'),
      ],
      { encoding: 'utf-8' }
    );
    if (made.status !== 0) throw new Error(`Não foi possível gerar o MKV de teste: ${made.stderr}`);

    const helpers = await import('./helpers');
    fixture = await helpers.startRangeServer(tmp);
    const { createApiRouter } = await import('../app');
    api = await helpers.startApi(createApiRouter);
    tracksCache = (await import('../media/tracks')).tracksCache;
    token = (await json(await fetch(`${api.base}/api/session`, { method: 'POST' }))).token;
    mediaUrl = `${fixture.base}/teste.mkv`;
  });

  afterAll(async () => {
    await api?.close();
    await fixture?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    for (const f of listCache()) if (!cacheBefore.has(f)) fs.rmSync(f, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('GET /api/tracks lista áudios, legenda, fonte e duração', async () => {
    const res = await fetch(`${api.base}/api/tracks?url=${encodeURIComponent(mediaUrl)}&fingerprint=t-tracks-${Date.now()}`, h());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.audios.map((a: any) => a.language)).toEqual(['jpn', 'por']);
    expect(body.subtitles).toHaveLength(1);
    expect(body.subtitles[0].codec).toMatch(/ass|ssa/);
    expect(body.fonts[0].filename).toBe('fonte.ttf');
    expect(body.duration).toBeGreaterThan(2);
  });

  it('proxy com Range devolve 206 e o corpo certo', async () => {
    const res = await fetch(`${api.base}/api/proxy?url=${encodeURIComponent(mediaUrl)}`, { headers: { 'X-Lunio-Token': token, Range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-99\/\d+$/);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('proxy nunca devolve text/html do upstream com o tipo original', async () => {
    fs.writeFileSync(path.join(tmp, 'pagina.html'), '<script>alert(1)</script>');
    const res = await fetch(`${api.base}/api/proxy?url=${encodeURIComponent(`${fixture.base}/pagina.html`)}`, h());
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('remux com áudio alternativo devolve fMP4 e rejeita índice de áudio inválido', async () => {
    const res = await fetch(`${api.base}/api/proxy?url=${encodeURIComponent(mediaUrl)}&audio=2&ss=0&gen=1&session=teste1`, h());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('x-mediarun-session')).toBe('teste1');
    const reader = res.body!.getReader();
    let bytes = 0;
    while (bytes < 2000) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
    }
    await reader.cancel();
    expect(bytes).toBeGreaterThan(1000);

    const bad = await fetch(`${api.base}/api/proxy?url=${encodeURIComponent(mediaUrl)}&audio=2%20-i%20x`, h());
    expect(bad.status).toBe(400);
  });

  it('GET /api/font extrai a fonte anexada e responde 404 para índice sem anexo', async () => {
    const fp = `t-font-${Date.now()}`;
    const url = `${api.base}/api/font?url=${encodeURIComponent(mediaUrl)}&fingerprint=${fp}`;
    const ok = await fetch(`${url}&track=4&name=fonte.ttf`, h());
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('font/ttf');
    expect((await ok.arrayBuffer()).byteLength).toBe(4096);
    const missing = await fetch(`${url}&track=1&name=nada.ttf`, h());
    expect(missing.status).toBe(404);
  });

  describe.skipIf(!pythonOk)('legendas (mkv_extractor + FFmpeg)', () => {
    it('extrai a legenda ASS embutida', async () => {
      const res = await fetch(`${api.base}/api/subtitle?url=${encodeURIComponent(mediaUrl)}&track=3&fingerprint=t-sub-${Date.now()}`, h());
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(await res.text()).toContain('Legenda de teste do Lunio');
    });

    it('token novo com o mesmo fingerprint reaproveita o cache (nenhum arquivo novo)', async () => {
      const fp = `ih:abc|f:0|n:teste.mkv|s:-${Date.now()}`;
      const url = (t: string) => `${api.base}/api/subtitle?url=${encodeURIComponent(`${mediaUrl}?token=${t}`)}&track=3&fingerprint=${encodeURIComponent(fp)}`;
      const first = await fetch(url('AAA'), h());
      expect(first.status).toBe(200);
      const afterFirst = listCache().length;
      const second = await fetch(url('BBB'), h());
      expect(second.status).toBe(200);
      expect(await second.text()).toContain('Legenda de teste');
      expect(listCache().length).toBe(afterFirst);
    });

    it('outro arquivo do mesmo torrent (fileIndex diferente) não divide cache', async () => {
      const base = `ih:def|f:%d|n:teste.mkv|s:-${Date.now()}`;
      const get = (i: number) => fetch(`${api.base}/api/subtitle?url=${encodeURIComponent(mediaUrl)}&track=3&fingerprint=${encodeURIComponent(base.replace('%d', String(i)))}`, h());
      expect((await get(0)).status).toBe(200);
      const n0 = listCache().length;
      expect((await get(1)).status).toBe(200);
      expect(listCache().length).toBe(n0 + 1);
    });

    it('faixa que não existe: 422 EXTRACTION_FAILED, sem arquivo ASS falso e sem vazar detalhes', async () => {
      const res = await fetch(`${api.base}/api/subtitle?url=${encodeURIComponent(mediaUrl)}&track=77&fingerprint=t-422-${Date.now()}`, h());
      expect(res.status).toBe(422);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ code: 'EXTRACTION_FAILED' });
      expect(text).not.toMatch(/[A-Z]:\\|\/tmp\/|ffmpeg version/i);
    });

    it('legenda em imagem (PGS/VobSub): 415 BITMAP_NOT_SUPPORTED', async () => {
      const url = `${mediaUrl}?pgs=${Date.now()}`;
      // o cliente só pede a legenda depois de /api/tracks; aqui semeamos o que o FFmpeg teria detectado
      tracksCache.set(url, {
        title: 't', rawTitle: 't', duration: 3, parsedTorrent: null, audios: [], chapters: [], fonts: [], streamUrl: url,
        subtitles: [{ index: 5, codec: 'hdmv_pgs_subtitle', language: 'eng', title: 'PGS' }],
      });
      const res = await fetch(`${api.base}/api/subtitle?url=${encodeURIComponent(url)}&track=5&fingerprint=t-pgs-${Date.now()}`, h());
      expect(res.status).toBe(415);
      expect(await json(res)).toMatchObject({ code: 'BITMAP_NOT_SUPPORTED' });
    });
  });
});
