import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { touchCacheFile } from '../cleanup';
import { config } from '../config';
import { spawnLimited } from '../limits';
import { ffmpegBin, getTools, killTree } from '../tools';
import { FFMPEG_NET_ONLY } from './ffmpeg';
import { HLS_CACHE_DIR } from './paths';
import { SEEK_COMPENSATION, buildPlan, segmentCount, type HlsPlan } from './hlsPlan';
import { resolveFinalCdnUrl } from './resolver';
import { tracksCache } from './tracks';

/**
 * HLS compartilhado para áudio alternativo.
 *
 * O vídeo é copiado e o áudio escolhido vira AAC, em segmentos de ~6 s guardados em disco. Todo mundo da sala que escolhe
 * o mesmo áudio usa os mesmos segmentos: a mídia entra na VPS uma vez por (vídeo, áudio) e o seek leva ~1 s, em vez de
 * reiniciar um FFmpeg por pessoa. Só funciona para MKV com Cues e vídeo H.264; o resto cai no remux contínuo.
 *
 * Os segmentos saem de lotes: um FFmpeg contínuo (`-f segment`) que produz `BATCH_SEGMENTS` segmentos a partir do ponto
 * pedido e termina. Pedido fora do que está sendo produzido abre outro lote.
 */

const BATCH_SEGMENTS = 30;
/** Se o segmento pedido estiver mais longe que isso do que o lote já produziu, abre um lote novo em vez de esperar. */
const MAX_WAIT_AHEAD = 8;
const MAX_BATCHES_PER_STREAM = 2;
/** Limite de FFmpeg do HLS por mídia (somando os áudios). */
const MAX_PROCS_PER_MEDIA = 3;
const SEGMENT_WAIT_MS = 45_000;

export class HlsError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string
  ) {
    super(message || code);
    this.name = 'HlsError';
  }
}

interface Batch {
  start: number;
  end: number; // exclusivo
  alive: boolean;
  /** Primeiro índice que ainda não foi concluído. */
  frontier: number;
  proc: ReturnType<typeof spawnLimited>;
  killed: boolean;
}

interface HlsMedia {
  id: string;
  sourceUrl: string;
  dir: string;
  plan: HlsPlan;
  batches: Map<number, Batch[]>; // por faixa de áudio
}

const medias = new Map<string, HlsMedia>();
export const hlsStats = { batchesStarted: 0 };

const mediaId = (key: string) => crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
const audioDir = (m: HlsMedia, audio: number) => path.join(m.dir, `a${audio}`);

// ───────────── plano (keyframes dos Cues) ─────────────

function readKeyframes(finalUrl: string): Promise<{ keyframes: number[]; videoCodec: string }> {
  const py = getTools().python;
  if (!py.found) return Promise.reject(new HlsError('python_missing', 501, 'Python 3.10+ não encontrado.'));
  return new Promise((resolve, reject) => {
    const proc = spawnLimited(py.command, [...py.args, '-u', '-m', 'mkv_extractor', finalUrl, '--keyframes'], { cwd: config.rootDir });
    if (!proc) return reject(new HlsError('busy', 503));
    let out = '';
    let err = '';
    const timer = setTimeout(() => killTree(proc), 60_000);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn('[HLS] Não foi possível ler os keyframes:', err.trim().slice(-200));
        return reject(new HlsError('no_keyframes', 501, 'O arquivo não tem índice de keyframes (Cues).'));
      }
      try {
        const json = JSON.parse(out);
        resolve({ keyframes: json.keyframes as number[], videoCodec: String(json.video_codec || '') });
      } catch {
        reject(new HlsError('no_keyframes', 501));
      }
    });
  });
}

/**
 * Registra (ou reaproveita) a mídia e devolve onde está a playlist. Lança `HlsError` quando o HLS não se aplica:
 * o cliente cai no remux contínuo.
 */
export async function startHls(params: { url: string; audio: number; fingerprint?: string }): Promise<{ id: string; playlist: string }> {
  const { url, audio, fingerprint } = params;
  const finalUrl = await resolveFinalCdnUrl(url); // valida SSRF
  const tracks = tracksCache.get(url);
  if (!tracks) throw new HlsError('tracks_missing', 409, 'Leia as faixas do vídeo antes.');
  if (!tracks.audios.some((a: any) => a.index === audio)) throw new HlsError('bad_audio', 400, 'Faixa de áudio inexistente.');
  if (!(tracks.duration > 0)) throw new HlsError('no_duration', 501, 'Duração desconhecida.');

  const id = mediaId(fingerprint && fingerprint.length > 3 ? fingerprint : url);
  let media = medias.get(id);
  if (!media) {
    const dir = path.join(HLS_CACHE_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const planFile = path.join(dir, 'plan.json');
    let plan: HlsPlan | null = null;
    try {
      plan = JSON.parse(fs.readFileSync(planFile, 'utf-8')) as HlsPlan;
    } catch {
      // primeira vez para esta mídia
    }
    if (!plan || Math.abs(plan.duration - tracks.duration) > 1) {
      const { keyframes, videoCodec } = await readKeyframes(finalUrl);
      if (!/V_MPEG4\/ISO\/AVC/i.test(videoCodec)) throw new HlsError('unsupported_codec', 501, 'Só vídeo H.264 usa HLS.');
      plan = buildPlan(keyframes, tracks.duration);
      fs.writeFileSync(planFile, JSON.stringify(plan));
    }
    media = { id, sourceUrl: url, dir, plan, batches: new Map() };
    medias.set(id, media);
  }
  fs.mkdirSync(audioDir(media, audio), { recursive: true });
  touchCacheFile(media.dir);
  return { id, playlist: `/api/hls/${id}/${audio}/index.m3u8` };
}

export function getPlan(id: string): HlsPlan {
  const media = medias.get(id);
  if (!media) throw new HlsError('unknown_media', 404, 'Mídia não registrada (recarregue).');
  return media.plan;
}

// ───────────── geração dos segmentos ─────────────

function finalFile(media: HlsMedia, audio: number, index: number) {
  return path.join(audioDir(media, audio), `${index}.ts`);
}
function removeWorkFiles(dir: string) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('w_')) continue;
      try {
        fs.rmSync(path.join(dir, f), { force: true });
      } catch {
        // em uso (Windows): o próximo lote limpa
      }
    }
  } catch {
    // pasta já não existe
  }
}
const workFile = (dir: string, index: number) => path.join(dir, `w_${String(index).padStart(5, '0')}.ts`);

function liveBatches(media: HlsMedia, audio: number): Batch[] {
  const list = (media.batches.get(audio) || []).filter((b) => b.alive);
  media.batches.set(audio, list);
  return list;
}

async function startBatch(media: HlsMedia, audio: number, start: number): Promise<Batch> {
  const { plan } = media;
  const n = segmentCount(plan);
  const end = Math.min(n, start + BATCH_SEGMENTS);
  const dir = audioDir(media, audio);

  const all = [...media.batches.values()].flat().filter((b) => b.alive);
  if (all.length >= MAX_PROCS_PER_MEDIA) throw new HlsError('busy', 503);

  // Sobras de um lote que caiu no meio
  removeWorkFiles(dir);

  const streamUrl = await resolveFinalCdnUrl(media.sourceUrl);
  const b0 = plan.boundaries[start];
  const times = plan.boundaries.slice(start + 1, end).map((t) => (t - b0).toFixed(3));
  const args = [
    '-hide_banner',
    '-v', 'error',
    ...FFMPEG_NET_ONLY,
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
    // +0,14: o FFmpeg recua ~0,13 s ao buscar (B-frames); assim o corte cai exatamente no keyframe `b0`
    '-ss', (b0 + SEEK_COMPENSATION).toFixed(3),
    '-copyts',
    '-i', streamUrl,
  ];
  if (end < n) args.push('-to', plan.boundaries[end].toFixed(3));
  args.push(
    '-map', '0:v:0',
    '-map', `0:${audio}`,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ac', '2',
    '-b:a', '256k',
    '-af', 'aresample=async=1,volume=1.8',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-avoid_negative_ts', 'disabled',
    '-f', 'segment',
    '-segment_format', 'mpegts',
    // Sem `-segment_time` (o FFmpeg 8 recusa junto com `-segment_times`); lote de um segmento só usa um limite inalcançável
    '-segment_times', times.length ? times.join(',') : '99999',
    '-segment_start_number', String(start),
    '-reset_timestamps', '0',
    path.join(dir, 'w_%05d.ts')
  );

  const proc = spawnLimited(ffmpegBin(), args);
  if (!proc) throw new HlsError('busy', 503);
  hlsStats.batchesStarted++;
  const batch: Batch = { start, end, alive: true, frontier: start, proc, killed: false };
  const list = media.batches.get(audio) || [];
  list.push(batch);
  media.batches.set(audio, list);
  console.log(`[HLS] Lote ${start}-${end - 1} (áudio #${audio}, mídia ${media.id}) iniciado`);

  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d.toString()));

  // Um segmento só é "pronto" quando o seguinte já começou (ou o FFmpeg terminou): aí ganha o nome final
  const promote = (finished: boolean) => {
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return;
    }
    const present = new Set(files.filter((f) => f.startsWith('w_')).map((f) => parseInt(f.slice(2, 7), 10)));
    for (const idx of [...present].sort((a, b) => a - b)) {
      if (idx >= end) {
        try {
          fs.rmSync(workFile(dir, idx), { force: true }); // sobra do `-to` (keyframe do limite)
        } catch {
          // ainda em uso: sai na próxima varredura
        }
        continue;
      }
      if (finished || present.has(idx + 1)) {
        try {
          fs.renameSync(workFile(dir, idx), finalFile(media, audio, idx));
          batch.frontier = Math.max(batch.frontier, idx + 1);
        } catch {
          // já promovido
        }
      }
    }
  };
  const watcher = setInterval(() => promote(false), 200);

  proc.on('error', (err) => {
    console.error('[HLS] Não foi possível iniciar o FFmpeg:', err.message);
  });
  proc.on('close', (code) => {
    clearInterval(watcher);
    batch.alive = false;
    if (code === 0 || batch.killed === false) {
      if (code === 0) promote(true);
    }
    // Sobras de segmento incompleto (no Windows o arquivo pode demorar a soltar; não é motivo para derrubar o servidor)
    removeWorkFiles(dir);
    if (code !== 0 && !batch.killed) console.warn(`[HLS] Lote ${start}-${end - 1} terminou com código ${code}: ${stderr.trim().slice(-300)}`);
    else console.log(`[HLS] Lote ${start}-${end - 1} concluído`);
  });
  return batch;
}

/** Garante que o segmento `index` exista ou esteja sendo produzido. */
async function ensureCovered(media: HlsMedia, audio: number, index: number) {
  if (fs.existsSync(finalFile(media, audio, index))) return;
  const live = liveBatches(media, audio);
  const covering = live.find((b) => index >= b.start && index < b.end && index - b.frontier <= MAX_WAIT_AHEAD && index >= b.frontier - 1);
  if (covering) return;
  // Dois lotes por faixa: o mais antigo cede lugar (o ponto de reprodução mudou)
  if (live.length >= MAX_BATCHES_PER_STREAM) {
    const oldest = live[0];
    oldest.killed = true;
    if (oldest.proc) killTree(oldest.proc);
  }
  await startBatch(media, audio, index);
}

/** Caminho do segmento pronto (espera ele sair do FFmpeg se for preciso). */
export async function getSegmentFile(id: string, audio: number, index: number): Promise<string> {
  const media = medias.get(id);
  if (!media) throw new HlsError('unknown_media', 404, 'Mídia não registrada (recarregue).');
  const n = segmentCount(media.plan);
  if (index < 0 || index >= n) throw new HlsError('not_found', 404);
  fs.mkdirSync(audioDir(media, audio), { recursive: true });

  const file = finalFile(media, audio, index);
  if (!fs.existsSync(file)) {
    await ensureCovered(media, audio, index);
    // Já deixa o próximo trecho encaminhado (evita engasgar na fronteira do lote)
    const ahead = index + 4;
    if (ahead < n && !fs.existsSync(finalFile(media, audio, ahead))) {
      const live = liveBatches(media, audio);
      if (live.length < MAX_BATCHES_PER_STREAM && !live.some((b) => ahead >= b.start && ahead < b.end)) {
        void startBatch(media, audio, ahead).catch(() => {});
      }
    }
    const deadline = Date.now() + SEGMENT_WAIT_MS;
    let retried = false;
    while (!fs.existsSync(file)) {
      if (Date.now() > deadline) throw new HlsError('timeout', 504, 'O segmento demorou demais.');
      const stillWorking = liveBatches(media, audio).some((b) => index >= b.start && index < b.end);
      if (!stillWorking && !fs.existsSync(file)) {
        // o lote acabou sem produzir o segmento (FFmpeg falhou ou foi cancelado por outro pedido): tenta uma vez de novo
        if (retried) throw new HlsError('generation_failed', 502, 'Não foi possível gerar o segmento.');
        retried = true;
        await ensureCovered(media, audio, index);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  touchCacheFile(file);
  return file;
}

/** Só para testes. */
export function resetHlsForTests() {
  for (const m of medias.values()) for (const list of m.batches.values()) for (const b of list) if (b.proc) killTree(b.proc);
  medias.clear();
  hlsStats.batchesStarted = 0;
}
