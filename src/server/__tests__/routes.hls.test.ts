import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasBinary } from './helpers';

process.env.ALLOW_PRIVATE_URLS = '1';
process.env.SESSION_SECRET = 'segredo-de-teste';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
const ready = hasBinary(ffmpeg) && hasBinary(ffprobe) && (hasBinary('python3', ['--version']) || hasBinary('python', ['--version']));
const CACHE = path.resolve(process.cwd(), '.cache', 'hls');

const json = async (res: Response) => res.json() as Promise<any>;

/** Pacotes de vídeo/áudio de um segmento: { video: [{pts, key}], audio: [pts] }. */
function packets(file: string) {
  const run = (sel: string, entries: string) =>
    spawnSync(ffprobe, ['-v', 'error', '-select_streams', sel, '-show_entries', `packet=${entries}`, '-of', 'csv=p=0', file], { encoding: 'utf-8' })
      .stdout.trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(','));
  return {
    video: run('v', 'pts_time,flags').map(([pts, flags]) => ({ pts: Number(pts), key: flags.includes('K') })),
    audio: run('a', 'pts_time').map(([pts]) => Number(pts)),
  };
}

describe.skipIf(!ready)('HLS compartilhado (áudio alternativo)', () => {
  let tmp: string;
  let fixture: { base: string; close(): Promise<void> };
  let api: { base: string; close(): Promise<void> };
  let token: string;
  let mediaUrl: string;
  let fingerprint: string;
  let hls: typeof import('../media/hls');
  let tracksCache: typeof import('../media/tracks').tracksCache;
  let planInfo: { id: string; playlist: string };
  const h = () => ({ headers: { 'X-Lunio-Token': token } });
  const post = (body: object) =>
    fetch(`${api.base}/api/hls/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lunio-Token': token }, body: JSON.stringify(body) });
  const cacheBefore = new Set<string>();

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (fs.existsSync(CACHE)) for (const f of fs.readdirSync(CACHE)) cacheBefore.add(f);

    // MKV de 45 s, keyframe a cada 1 s (10 fps, -g 10), 2 áudios
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-hls-'));
    const made = spawnSync(
      ffmpeg,
      [
        '-hide_banner', '-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=duration=45:size=160x90:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=45',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=45',
        '-map', '0:v', '-map', '1:a', '-map', '2:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '10', '-c:a', 'aac',
        '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=por',
        path.join(tmp, 'hls.mkv'),
      ],
      { encoding: 'utf-8' }
    );
    if (made.status !== 0) throw new Error(`Não foi possível gerar o MKV de teste: ${made.stderr}`);
    // o mesmo vídeo em MP4: sem Cues do Matroska, o HLS não se aplica e o servidor tem que dizer isso
    const mp4 = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', path.join(tmp, 'hls.mkv'), '-c', 'copy', path.join(tmp, 'copia.mp4')], { encoding: 'utf-8' });
    if (mp4.status !== 0) throw new Error(`Não foi possível gerar o MP4 de teste: ${mp4.stderr}`);

    const helpers = await import('./helpers');
    fixture = await helpers.startRangeServer(tmp);
    const { createApiRouter } = await import('../app');
    api = await helpers.startApi(createApiRouter);
    hls = await import('../media/hls');
    tracksCache = (await import('../media/tracks')).tracksCache;
    token = (await json(await fetch(`${api.base}/api/session`, { method: 'POST' }))).token;
    mediaUrl = `${fixture.base}/hls.mkv`;
    fingerprint = `t-hls-${Date.now()}`;

    // o cliente sempre lê as faixas antes
    const tr = await fetch(`${api.base}/api/tracks?url=${encodeURIComponent(mediaUrl)}&fingerprint=${fingerprint}`, h());
    expect(tr.status).toBe(200);
  });

  afterAll(async () => {
    hls?.resetHlsForTests();
    await api?.close();
    await fixture?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 500)); // deixa o FFmpeg soltar os arquivos (Windows)
    if (fs.existsSync(CACHE)) {
      for (const f of fs.readdirSync(CACHE)) {
        if (cacheBefore.has(f)) continue;
        try {
          fs.rmSync(path.join(CACHE, f), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
          // o LRU de cleanup.ts apaga depois
        }
      }
    }
    vi.restoreAllMocks();
  });

  it('recusa quando não dá para usar HLS (faixas não lidas, áudio inexistente, sem Cues)', async () => {
    const noTracks = await post({ url: `${fixture.base}/outro.mkv`, audio: 2, fingerprint: 'x1234' });
    expect([404, 409]).toContain(noTracks.status); // 404 do fixture ou 409 tracks_missing; nunca 200
    const badAudio = await post({ url: mediaUrl, audio: 9, fingerprint });
    expect(badAudio.status).toBe(400);
    expect(await json(badAudio)).toMatchObject({ code: 'bad_audio' });
    const missing = await post({ url: mediaUrl });
    expect(missing.status).toBe(400);

    // MP4 (sem Cues do Matroska): 501 e o cliente usa o remux contínuo
    tracksCache.set(`${fixture.base}/copia.mp4`, { title: 't', rawTitle: 't', duration: 45, parsedTorrent: null, audios: [{ index: 2 }], subtitles: [], chapters: [], fonts: [], streamUrl: '' });
    const noCues = await post({ url: `${fixture.base}/copia.mp4`, audio: 2, fingerprint: `copia-sem-cues-${Date.now()}` });
    expect(noCues.status).toBe(501);
    expect(await json(noCues)).toMatchObject({ code: 'no_keyframes' });
  });

  it('start devolve a playlist e ela é VOD com segmentos de ~6 s cobrindo o vídeo todo', async () => {
    const res = await post({ url: mediaUrl, audio: 2, fingerprint });
    expect(res.status).toBe(200);
    planInfo = await json(res);
    expect(planInfo.playlist).toMatch(/^\/api\/hls\/[a-f0-9]{16}\/2\/index\.m3u8$/);

    const pl = await fetch(`${api.base}${planInfo.playlist}?t=${encodeURIComponent(token)}`);
    expect(pl.status).toBe(200);
    expect(pl.headers.get('content-type')).toContain('mpegurl');
    const text = await pl.text();
    expect(text).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(text).toContain('#EXT-X-ENDLIST');
    expect(text).toContain(`0.ts?t=${encodeURIComponent(token)}`); // token propagado: o player não manda cabeçalhos
    const durations = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
    expect(durations.length).toBeGreaterThanOrEqual(6);
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(45, 0);
    for (const d of durations.slice(0, -1)) expect(d).toBeGreaterThanOrEqual(5.5);
    for (const d of durations) expect(d).toBeLessThanOrEqual(8);
  });

  it('exige token e valida o caminho', async () => {
    expect((await fetch(`${api.base}${planInfo.playlist}`)).status).toBe(401);
    expect((await fetch(`${api.base}/api/hls/zzzz/2/index.m3u8`, h())).status).toBe(404);
    expect((await fetch(`${api.base}/api/hls/${planInfo.id}/2/../../x.ts`, h())).status).toBe(404);
    expect((await fetch(`${api.base}/api/hls/${planInfo.id}/2/999.ts`, h())).status).toBe(404);
    expect((await fetch(`${api.base}/api/hls/0123456789abcdef/2/index.m3u8`, h())).status).toBe(404);
  });

  it('dois espectadores pedindo os mesmos segmentos usam UM só FFmpeg e recebem os mesmos bytes', async () => {
    const before = hls.hlsStats.batchesStarted;
    const seg = (i: number) => fetch(`${api.base}/api/hls/${planInfo.id}/2/${i}.ts`, h()).then(async (r) => ({ status: r.status, buf: Buffer.from(await r.arrayBuffer()) }));
    const [a0, b0] = await Promise.all([seg(0), seg(0)]);
    const [a1, b1] = await Promise.all([seg(1), seg(1)]);
    expect(a0.status).toBe(200);
    expect(b0.status).toBe(200);
    expect(a0.buf.equals(b0.buf)).toBe(true);
    expect(a1.buf.equals(b1.buf)).toBe(true);
    expect(a0.buf.length).toBeGreaterThan(1000);
    // um lote atende os dois (mais, no máximo, o lote de pré-busca para o trecho à frente)
    expect(hls.hlsStats.batchesStarted - before).toBeLessThanOrEqual(2);
    expect(hls.hlsStats.batchesStarted - before).toBeGreaterThanOrEqual(1);
    // segundo pedido depois de pronto: sai do disco, sem novo FFmpeg
    const mid = hls.hlsStats.batchesStarted;
    await seg(0);
    await seg(1);
    expect(hls.hlsStats.batchesStarted).toBe(mid);
  });

  it('cada segmento começa num keyframe, no instante certo, e eles se encadeiam sem buraco nem sobreposição', async () => {
    const text = await (await fetch(`${api.base}${planInfo.playlist}`, h())).text();
    const durations = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
    const starts = durations.map((_, i) => durations.slice(0, i).reduce((a, b) => a + b, 0));

    const files: string[] = [];
    for (let i = 0; i < durations.length; i++) {
      const res = await fetch(`${api.base}/api/hls/${planInfo.id}/2/${i}.ts`, h());
      expect(res.status, `segmento ${i}`).toBe(200);
      const file = path.join(tmp, `s${i}.ts`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      files.push(file);
    }

    let prevEnd = 0;
    files.forEach((file, i) => {
      const p = packets(file);
      const firstVideo = Math.min(...p.video.map((v) => v.pts));
      expect(firstVideo, `início do segmento ${i}`).toBeCloseTo(starts[i], 1);
      expect(p.video.find((v) => v.pts === firstVideo)?.key, `segmento ${i} começa em keyframe`).toBe(true);
      const lastVideo = Math.max(...p.video.map((v) => v.pts));
      if (i > 0) expect(firstVideo - prevEnd, `buraco entre ${i - 1} e ${i}`).toBeLessThan(0.25);
      expect(firstVideo, `sobreposição entre ${i - 1} e ${i}`).toBeGreaterThan(prevEnd - 0.01);
      prevEnd = lastVideo + 0.1; // um quadro (10 fps)
      // áudio presente e dentro da janela do segmento (± um pacote AAC)
      expect(p.audio.length).toBeGreaterThan(5);
      expect(Math.min(...p.audio)).toBeGreaterThan(starts[i] - 0.5);
      expect(Math.max(...p.audio)).toBeLessThan(starts[i] + durations[i] + 0.5);
    });
    expect(prevEnd).toBeCloseTo(45, 0);
  });

  it('seek longe: pedir um segmento do fim abre outro lote e responde rápido', async () => {
    // outra faixa de áudio (sem nada em cache) e direto o penúltimo segmento
    const res = await post({ url: mediaUrl, audio: 1, fingerprint });
    expect(res.status).toBe(200);
    const text = await (await fetch(`${api.base}${(await json(res)).playlist}`, h())).text();
    const n = (text.match(/#EXTINF/g) || []).length;
    const t0 = Date.now();
    const seg = await fetch(`${api.base}/api/hls/${planInfo.id}/1/${n - 2}.ts`, h());
    expect(seg.status).toBe(200);
    expect((await seg.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('o remux antigo continua disponível (fallback)', async () => {
    const res = await fetch(`${api.base}/api/proxy?url=${encodeURIComponent(mediaUrl)}&audio=2&ss=3&gen=1&session=hls-fallback`, h());
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let bytes = 0;
    while (bytes < 2000) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
    }
    await reader.cancel();
    expect(bytes).toBeGreaterThan(1000);
  });
});
