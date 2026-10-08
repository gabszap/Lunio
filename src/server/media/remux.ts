import http from 'node:http';
import { sendApiError } from '../http';
import { spawnLimited } from '../limits';
import { ffmpegBin, killTree } from '../tools';
import { FFMPEG_NET_ONLY } from './ffmpeg';
import { getMediaFingerprint } from './fingerprint';
import { resolveFinalCdnUrl } from './resolver';

// Gerenciamento de processos de remux para Regions e Cold Seek controlado
interface ActiveRemuxProcess {
  proc: import('node:child_process').ChildProcess;
  sessionId: string;
  generation: number;
  url: string;
  startedAt: number;
  kill: () => void;
  seek: number;
  audio: string | null;
  /** Reconecta um novo request do navegador ao mesmo FFmpeg a partir do byte pedido. */
  attach: (req: http.IncomingMessage, res: http.ServerResponse, fromByte: number) => boolean;
}
// Quanto da saída do remux guardar para retomar após o navegador fechar/reabrir a conexão (pause, readahead)
const REMUX_TAIL_LIMIT = 96 * 1024 * 1024;
const activeRemuxProcesses = new Map<string, ActiveRemuxProcess>();

export interface RemuxParams {
  targetUrl: string;
  /** Índice da faixa de áudio (string numérica) ou null para a primeira. */
  audioTrack: string | null;
  seekSeconds: number;
  sessionId: string;
  generation: number;
}

/**
 * Remux fMP4 sob demanda com a faixa de áudio escolhida (FFmpeg → resposta HTTP).
 * Reaproveita o FFmpeg quando o navegador reabre a mesma URL (mesma geração/`ss`/áudio).
 */
export async function handleRemux(req: http.IncomingMessage, res: http.ServerResponse, params: RemuxParams): Promise<void> {
  const { targetUrl, audioTrack, seekSeconds, sessionId, generation } = params;
  const remuxKey = sessionId ? `session_${sessionId}` : `url_${getMediaFingerprint(targetUrl)}_${audioTrack || '0'}`;
  const rangeMatch = /bytes=(\d+)-/.exec(String(req.headers['range'] || ''));
  const rangeStart = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;

  // O navegador costuma abrir a mesma URL de remux duas vezes seguidas (e pode reabrir após suspender
  // o download). Mesma geração e mesmo ponto = mesma mídia: reaproveita o FFmpeg e o que ele já gerou
  // em vez de matar o processo e recomeçar do `ss`.
  const existing = activeRemuxProcesses.get(remuxKey);
  if (existing && existing.generation === generation && existing.seek === seekSeconds && existing.audio === audioTrack) {
    if (existing.attach(req, res, rangeStart)) {
      console.log(`[MediaProxy] ⏯️ Reconexão do navegador: retomando remux existente a partir do byte ${rangeStart} [Geração ${generation}]`);
      return;
    }
    console.log(`[MediaProxy] Byte ${rangeStart} fora do buffer do remux; reiniciando FFmpeg.`);
  }

  // Cancela processo FFmpeg anterior imediatamente ao detectar nova geração / Cold Seek
  if (existing) {
    console.log(`[MediaProxy] ❄️ Cold Seek físico detectado (Gen ${generation} vs anterior ${existing.generation}). Cancelando processo FFmpeg anterior imediatamente...`);
    existing.kill();
    activeRemuxProcesses.delete(remuxKey);
  }

  console.log(`[MediaProxy] 🎬 Remuxando fMP4 via FFmpeg: áudio #${audioTrack || 'default'}, seek ${seekSeconds}s [Geração ${generation} / Session ${sessionId || 'none'}]...`);

  let streamUrl = await resolveFinalCdnUrl(targetUrl);
  const ffmpegArgs: string[] = [
    '-hide_banner',
    '-v', 'error',
    ...FFMPEG_NET_ONLY,
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
  ];

  if (seekSeconds > 0) {
    ffmpegArgs.push('-ss', seekSeconds.toFixed(2));
  }

  ffmpegArgs.push('-i', streamUrl);
  ffmpegArgs.push('-map', '0:v:0');

  if (audioTrack !== null && audioTrack !== undefined && audioTrack !== '') {
    ffmpegArgs.push('-map', `0:${audioTrack}`);
  } else {
    ffmpegArgs.push('-map', '0:a:0?');
  }

  ffmpegArgs.push(
    '-fflags', '+genpts+discardcorrupt',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ac', '2',
    '-b:a', '256k',
    '-af', 'aresample=async=1,volume=1.8',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    '-'
  );

  const ffmpegProc = spawnLimited(ffmpegBin(), ffmpegArgs);
  if (!ffmpegProc) {
    res.setHeader('Retry-After', '5');
    sendApiError(res, 503, 'busy');
    return;
  }

  // Últimos bytes produzidos (para retomar) + quem está consumindo agora
  const tail: Buffer[] = [];
  let tailStart = 0;
  let tailBytes = 0;
  let bytesOut = 0;
  let ended = false;
  let current: http.ServerResponse | null = null;
  let closeTimer: NodeJS.Timeout | null = null;

  let isCleanedUp = false;
  const cleanUp = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    try {
      killTree(ffmpegProc);
    } catch {}
    if (current && !current.writableEnded) current.end();
    current = null;
    tail.length = 0;
    if (activeRemuxProcesses.get(remuxKey)?.proc === ffmpegProc) {
      activeRemuxProcesses.delete(remuxKey);
    }
  };

  // Mantém o FFmpeg vivo (parado por backpressure) durante pausas de até 90s
  const scheduleCleanUp = () => {
    if (closeTimer || isCleanedUp) return;
    closeTimer = setTimeout(cleanUp, 90000);
  };

  ffmpegProc.stdout.on('data', (chunk: Buffer) => {
    tail.push(chunk);
    tailBytes += chunk.length;
    bytesOut += chunk.length;
    while (tail.length > 1 && tailBytes - tail[0].length >= REMUX_TAIL_LIMIT) {
      const dropped = tail.shift()!;
      tailBytes -= dropped.length;
      tailStart += dropped.length;
    }
    if (current && !current.writableEnded) {
      if (!current.write(chunk)) {
        ffmpegProc.stdout.pause();
        const res0 = current;
        res0.once('drain', () => {
          if (current === res0) ffmpegProc.stdout.resume();
        });
      }
    } else {
      // Ninguém ouvindo: segura o FFmpeg até o navegador reconectar
      ffmpegProc.stdout.pause();
    }
  });
  ffmpegProc.stdout.on('end', () => {
    ended = true;
    if (current && !current.writableEnded) current.end();
  });

  const attach = (aReq: http.IncomingMessage, aRes: http.ServerResponse, fromByte: number): boolean => {
    if (isCleanedUp || fromByte < tailStart || fromByte > bytesOut) return false;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (current && current !== aRes && !current.writableEnded) current.end();
    current = aRes;

    aRes.setHeader('Content-Type', 'video/mp4');
    aRes.setHeader('Accept-Ranges', 'none');
    aRes.setHeader('Cache-Control', 'no-cache, no-store');
    aRes.setHeader('Connection', 'keep-alive');
    if (sessionId) aRes.setHeader('X-MediaRun-Session', sessionId);
    if (generation) aRes.setHeader('X-MediaRun-Generation', String(generation));
    aRes.setHeader('X-MediaRegion-Start', seekSeconds.toFixed(2));
    if (fromByte > 0) {
      // Tamanho total desconhecido (stream ao vivo do FFmpeg)
      aRes.statusCode = 206;
      aRes.setHeader('Content-Range', `bytes ${fromByte}-${Number.MAX_SAFE_INTEGER - 1}/*`);
    } else {
      aRes.statusCode = 200;
    }

    // Reenvia o que o navegador ainda não tinha recebido
    let offset = tailStart;
    for (const chunk of tail) {
      const chunkEnd = offset + chunk.length;
      if (chunkEnd > fromByte) aRes.write(fromByte > offset ? chunk.subarray(fromByte - offset) : chunk);
      offset = chunkEnd;
    }

    if (ended) aRes.end();
    else ffmpegProc.stdout.resume();

    const onClose = () => {
      if (current === aRes) {
        current = null;
        ffmpegProc.stdout.pause();
        scheduleCleanUp();
      }
    };
    aReq.on('close', onClose);
    aRes.on('close', onClose);
    return true;
  };

  activeRemuxProcesses.set(remuxKey, {
    proc: ffmpegProc,
    sessionId,
    generation,
    url: targetUrl,
    startedAt: Date.now(),
    kill: cleanUp,
    seek: seekSeconds,
    audio: audioTrack,
    attach,
  });

  attach(req, res, 0);

  ffmpegProc.stderr.on('data', (d) => {
    console.warn('[FFmpeg Stderr]', d.toString());
  });
  ffmpegProc.on('error', (err) => {
    console.error('[MediaProxy] Não foi possível iniciar o FFmpeg:', err.message);
    if (!res.headersSent) sendApiError(res, 500, 'internal');
    cleanUp();
  });

  return;
}
