import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateAssDocument } from '../../lib/subtitleFormats';
import { config } from '../config';
import { spawnLimited } from '../limits';
import { ffmpegBin, getTools, killTree } from '../tools';
import { FFMPEG_NET_ONLY } from './ffmpeg';
import { ffmpegMbpsFor, recordFfmpegRead } from './ffmpegSpeed';
import { warmFonts } from './fonts';
import { getMediaFingerprint } from './fingerprint';
import { SUB_CACHE_DIR } from './paths';
import { resolveFinalCdnUrl } from './resolver';
import { tracksCache } from './tracks';
import { isInternalUploadUrl } from './uploads';
import { cooldownRemainingMs, hostOf, noteRateLimited, runOnHost } from './upstreamGate';
import { readCachedSubtitle, writeCachedSubtitle, type CachedSubtitleV2 } from './subtitleCache';
import { subtitleProgress } from './subtitleProgress';

const pendingSubtitleExtractions = new Map<string, Promise<string>>();
const activeSubtitleProcesses = new Map<string, () => void>();
/** Quem já está na fila do portão e pode ser promovido quando o usuário pede a mesma faixa que estava só em pré-extração. */
const gateBumps = new Map<string, () => void>();
const interactiveWanted = new Set<string>();

function readSubtitleOutput(file: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
  } catch (cause) {
    throw Object.assign(new Error('Saída local da legenda inválida.', { cause }), { code: 'SUBTITLE_INVALID' });
  }
}

function publishSubtitle(hash: string, track: string, content: string, producer: CachedSubtitleV2['producer']) {
  try {
    writeCachedSubtitle(hash, track, content, producer);
  } catch (error: any) {
    if (error?.code === 'SUBTITLE_INVALID') throw error;
    throw Object.assign(new Error('Falha ao publicar cache da legenda.', { cause: error }), { code: 'SUBTITLE_CACHE_FAILED' });
  }
}

/** `[TotalSize] 935568536` (o extrator informa o tamanho do arquivo quando prefere o FFmpeg). */
function parseTotalSize(stderr: string): number | null {
  const m = /\[TotalSize\] (\d+)/.exec(stderr);
  return m ? Number(m[1]) : null;
}

/** `[HttpStatus] 429 retry-after=15` (linha que o mkv_extractor escreve quando o servidor respondeu com erro). */
function parseHttpStatus(stderr: string): { status: number; retryAfter?: number } | null {
  const m = /\[HttpStatus\] (\d{3})(?: retry-after=(\d+))?/.exec(stderr);
  return m ? { status: Number(m[1]), retryAfter: m[2] ? Number(m[2]) : undefined } : null;
}

function rateLimitedError(retryAfterSec: number): Error {
  const err: any = new Error('O CDN limitou as requisições (429).');
  err.code = 'UPSTREAM_RATE_LIMITED';
  err.retryAfter = retryAfterSec;
  return err;
}

/** A extração remota (HTTP Range) falha por motivos passageiros (CDN lenta, conexão cortada): tenta algumas vezes antes do FFmpeg. */
const REMOTE_ATTEMPT_TIMEOUT_MS = 60_000;
const REMOTE_ATTEMPTS = 3;
const REMOTE_RETRY_DELAY_MS = 1500;

/**
 * Extração de alta performance via mkv_extractor (HTTP Range + EBML Cues)
 * Baixa apenas ~1-2 MB da legenda em 3-8s em vez de GBs pelo FFmpeg.
 */
async function extractRemoteMkvSubtitle(
  streamUrl: string,
  track: string,
  outputFile: string,
  extractionKey: string,
  ffmpegMbps: number,
  format: 'ass' | 'srt'
): Promise<string> {
  const args = [
    '-u',
    '-m', 'mkv_extractor',
    streamUrl,
    // Quanto o FFmpeg lê deste CDN (medido), para o extrator decidir se compensa
    '--ffmpeg-mbps', ffmpegMbps.toFixed(1),
    // Índice de stream do FFmpeg (o mesmo do /api/tracks), não o TrackNumber do Matroska
    '--stream-index', String(track),
    '-o', outputFile,
    '--json',
    '--strict',
  ];
  if (!config.allowPrivateUrls) {
    args.push('--public-only');
    if (isInternalUploadUrl(new URL(streamUrl))) args.push('--allow-origin', new URL(streamUrl).origin);
  }

  return await new Promise<string>((resolve, reject) => {
    const py = getTools().python;
    if (!py.found) {
      reject(new Error('Python 3.10+ não encontrado.'));
      return;
    }
    const proc = spawnLimited(py.command, [...py.args, ...args], {
      cwd: config.rootDir,
      // UTF-8 no stderr do Python também no Windows (acentos nas mensagens)
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    if (!proc) {
      const busy: any = new Error('Servidor ocupado (limite de processos).');
      busy.code = 'busy';
      reject(busy);
      return;
    }
    let stderr = '';
    let stdout = '';
    let finished = false;
    proc.stderr?.on('data', (d) => stderr += d.toString());
    proc.stdout?.on('data', (d) => stdout += d.toString());
    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      activeSubtitleProcesses.delete(extractionKey);
      reject(err);
    });

    activeSubtitleProcesses.set(extractionKey, () => {
      try {
        console.log(`[MkvExtractor] ⏹ Cancelando extração remota da faixa #${track}...`);
        killTree(proc);
      } catch {}
    });

    const timer = setTimeout(() => {
      finished = true;
      killTree(proc);
      reject(new Error(`Tempo limite de ${REMOTE_ATTEMPT_TIMEOUT_MS / 1000}s excedido no mkv_extractor.`));
    }, REMOTE_ATTEMPT_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      activeSubtitleProcesses.delete(extractionKey);
      if (finished) return;
      finished = true;
      if (code === 0) {
        try {
          const content = readSubtitleOutput(outputFile);
          const metadata = JSON.parse(stdout);
          if (metadata.format !== format || metadata.coverage !== 'verified' || path.resolve(metadata.output_file) !== path.resolve(outputFile)) {
            throw new Error('Formato, cobertura ou caminho de saída inconsistente no mkv_extractor.');
          }
          resolve(content);
        } catch (err: any) {
          reject(Object.assign(err, { code: 'SUBTITLE_INVALID' }));
        }
      } else {
        const errMsg = (stderr || stdout || '').trim();
        const err: any = new Error(`mkv_extractor finalizou com código ${code}: ${errMsg.slice(-300)}`);
        // The CLI reports local output/encoding failures separately from transport failures.
        if (/\[FatalError\] (?:OSError|PermissionError|FileNotFoundError|IsADirectoryError|NotADirectoryError|FileExistsError):/.test(errMsg)) {
          err.code = 'SUBTITLE_CACHE_FAILED';
        } else if (/\[FatalError\] Unicode(?:Encode|Decode|Translate)?Error:/.test(errMsg)) {
          err.code = 'SUBTITLE_INVALID';
        }
        err.fallbackReason = /\[FallbackReason\] ([a-z_]+)/.exec(errMsg)?.[1];
        err.nonRetryable = Boolean(err.fallbackReason && err.fallbackReason !== 'http_transport_error');
        // O extrator avisa (código 4) quando a conta de requisições sai mais cara que ler o arquivo com o FFmpeg
        if (code === 4 || /\[PreferFfmpeg\]/.test(errMsg)) {
          err.preferFfmpeg = true;
          err.totalSize = parseTotalSize(errMsg);
        }
        const http = parseHttpStatus(errMsg);
        if (http) {
          err.httpStatus = http.status;
          err.retryAfter = http.retryAfter;
          if (http.status === 429) err.nonRetryable = false;
        }
        reject(err);
      }
    });
  });
}


async function convertLocalSrt(input: string, output: string, extractionKey: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const proc = spawnLimited(ffmpegBin(), [
      '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', input, '-c:s', 'ass', '-f', 'ass', '-y', output,
    ]);
    if (!proc) {
      reject(Object.assign(new Error('Servidor ocupado (limite de processos).'), { code: 'busy' }));
      return;
    }
    let stderr = '';
    let finished = false;
    proc.stderr?.on('data', d => stderr += d.toString());
    const timer = setTimeout(() => { finished = true; killTree(proc); reject(new Error('Tempo limite na conversão local SRT → ASS.')); }, 30_000);
    activeSubtitleProcesses.set(extractionKey, () => killTree(proc));
    proc.on('error', err => { finished = true; clearTimeout(timer); reject(err); });
    proc.on('close', code => {
      clearTimeout(timer);
      activeSubtitleProcesses.delete(extractionKey);
      if (finished) return;
      finished = true;
      if (code !== 0) { reject(new Error(`Falha na conversão local SRT → ASS: ${stderr.slice(-300)}`)); return; }
      try {
        const content = readSubtitleOutput(output);
        if (!validateAssDocument(content).valid) throw new Error('ASS local inválido.');
        resolve(content);
      } catch (err) { reject(err); }
    });
  });
}

/**
 * Extração individual resiliente: mkv_extractor primeiro, FFmpeg como fallback
 */
async function extractSubtitleTrack(targetUrl: string, track: string, customFingerprint?: string, prefetch = false): Promise<string> {
  const hash = getMediaFingerprint(targetUrl, customFingerprint);
  const cached = readCachedSubtitle(hash, track);
  if (cached !== null) {
    subtitleProgress.set(hash, track, 'ready');
    return cached;
  }

  const extractionKey = `${hash}_${track}`;
  if (pendingSubtitleExtractions.has(extractionKey)) {
    // O usuário pediu uma faixa que só estava sendo pré-carregada: ela passa na frente da fila
    if (!prefetch) {
      interactiveWanted.add(extractionKey);
      gateBumps.get(extractionKey)?.();
    }
    return await pendingSubtitleExtractions.get(extractionKey)!;
  }

  subtitleProgress.set(hash, track, 'queued');
  const temporaryFiles = new Set<string>();
  let gateWaitTimer: ReturnType<typeof setInterval> | undefined;
  const extractionPromise = (async () => {
    try {
      const streamUrl = await resolveFinalCdnUrl(targetUrl);
      const cachedTracks = tracksCache.get(targetUrl);
      const subInfo = cachedTracks?.subtitles?.find((s: any) => String(s.index) === String(track));
      const subCodec = (subInfo?.codec || '').toLowerCase();
      // Nos logs, "#3" sozinho não diz qual é a legenda: junta o idioma e o título da faixa
      const subName = [subInfo?.language, subInfo?.title].filter(Boolean).join(' · ');
      const trackLabel = subName ? `#${track} (${subName})` : `#${track}`;

      // Se for formato bitmap (PGS, VobSub), rejeita com código específico para o resolver dar fallback
      if (subCodec === 'none' || /pgs|pgssub|dvd_sub|dvb_sub|xsub|dvdsub|vobsub|bitmap/i.test(subCodec)) {
        const err: any = new Error('Formato bitmap/PGS não suporta extração direta de texto.');
        err.code = 'BITMAP_NOT_SUPPORTED';
        throw err;
      }

      // Uma extração por vez por host do CDN (limite de conexões do TorBox); as pedidas pelo usuário passam as pré-extrações
      const host = hostOf(streamUrl);
      const reportGateWait = () => {
        const wait = cooldownRemainingMs(host);
        const stage = wait > 0 ? 'waiting_cdn' : 'queued';
        const previous = subtitleProgress.get(hash, track);
        const retryAt = wait > 0 ? Date.now() + wait : undefined;
        if (previous?.stage !== stage || previous?.retryAt !== retryAt) {
          subtitleProgress.set(hash, track, stage, { retryAt });
        }
      };
      reportGateWait();
      gateWaitTimer = setInterval(reportGateWait, 500);
      gateWaitTimer.unref();
      const gated = runOnHost(host, prefetch && !interactiveWanted.has(extractionKey) ? 'prefetch' : 'interactive', async () => {
      clearInterval(gateWaitTimer);
      subtitleProgress.set(hash, track, 'extracting');
      fs.mkdirSync(SUB_CACHE_DIR, { recursive: true });
      const tmpFile = path.join(SUB_CACHE_DIR, `${hash}_track${track}_${randomUUID()}.tmp.ass`);
      const nativeFormat: 'ass' | 'srt' | null = /ass|ssa/.test(subCodec) ? 'ass' : /subrip|srt|s_text\/utf8/.test(subCodec) ? 'srt' : null;
      const nativeFile = nativeFormat === 'srt' ? tmpFile.replace(/\.ass$/, '.srt') : tmpFile;
      temporaryFiles.add(tmpFile);
      temporaryFiles.add(nativeFile);

      // 1. Tenta primeiro extração remota ultrarrápida via HTTP Range (módulo mkv_extractor)
      const isCandidateMkv = targetUrl.toLowerCase().includes('.mkv') ||
                             streamUrl.toLowerCase().includes('.mkv') ||
                             cachedTracks?.container?.includes('matroska') ||
                             subCodec.includes('ass') ||
                             subCodec.includes('ssa');

      // Tamanho do arquivo quando o extrator preferiu o FFmpeg: serve para medir a velocidade dessa leitura
      let fileSizeForSpeed: number | null = null;
      let nativeContent: string | undefined;
      if (isCandidateMkv && nativeFormat) {
        try {
          console.log(`[Subtitle] 🚀 Tentando extração remota ultrarrápida (HTTP Range / EBML) para faixa ${trackLabel}...`);
          for (let attempt = 1; ; attempt++) {
            try {
              subtitleProgress.set(hash, track, 'extracting');
              nativeContent = await extractRemoteMkvSubtitle(streamUrl, track, nativeFile, extractionKey, ffmpegMbpsFor(host), nativeFormat);
              break;
            } catch (attemptErr: any) {
              // Sem Python, servidor ocupado ou estouro de tempo não melhora tentando de novo: o retry é para falha de
              // conexão. Num arquivo grande o extrator estoura os 60 s mesmo sozinho, e repetir só triplicava a espera
              // antes do FFmpeg (medido: 3 x 60 s perdidos, o FFmpeg terminou em ~65 s).
              if (
                attempt >= REMOTE_ATTEMPTS ||
                attemptErr?.code === 'busy' ||
                attemptErr?.code === 'SUBTITLE_INVALID' ||
                attemptErr?.code === 'SUBTITLE_CACHE_FAILED' ||
                /Python 3\.10\+ não encontrado/.test(attemptErr?.message || '') ||
                /^Tempo limite/.test(attemptErr?.message || '') ||
                attemptErr?.preferFfmpeg || attemptErr?.nonRetryable
              ) throw attemptErr;
              const limited = attemptErr?.httpStatus === 429;
              if (limited) noteRateLimited(host, attemptErr.retryAfter);
              if (limited) subtitleProgress.set(hash, track, 'waiting_cdn', { retryAt: Date.now() + cooldownRemainingMs(host), errorCode: 'UPSTREAM_RATE_LIMITED' });
              else subtitleProgress.set(hash, track, 'queued');
              console.warn(`[Subtitle] ↻ Tentativa ${attempt}/${REMOTE_ATTEMPTS} falhou na faixa ${trackLabel} (${attemptErr.message?.slice(0, 100)}). ${limited ? 'CDN pediu para esperar' : 'Tentando de novo'}…`);
              try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
              try { if (nativeFile !== tmpFile && fs.existsSync(nativeFile)) fs.unlinkSync(nativeFile); } catch {}
              // Depois de um 429 o portão espera o cooldown; nos outros erros, o recuo curto de antes
              await new Promise((r) => setTimeout(r, limited ? Math.max(cooldownRemainingMs(host), REMOTE_RETRY_DELAY_MS) : REMOTE_RETRY_DELAY_MS * attempt));
            }
          }

        } catch (mkvErr: any) {
          try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
          try { if (nativeFile !== tmpFile && fs.existsSync(nativeFile)) fs.unlinkSync(nativeFile); } catch {}
          if (mkvErr?.fallbackReason === 'url_blocked') {
            mkvErr.code = 'url_blocked';
            throw mkvErr;
          }
          if (mkvErr?.code === 'SUBTITLE_INVALID') throw mkvErr;
          if (mkvErr?.code === 'SUBTITLE_CACHE_FAILED') throw mkvErr;
          if (mkvErr?.code === 'busy') throw mkvErr;
          if (mkvErr?.httpStatus === 429) {
            noteRateLimited(host, mkvErr.retryAfter);
            console.warn(`[Subtitle] ⏳ CDN limitou as requisições na faixa ${trackLabel}; sem fallback FFmpeg (abriria outra conexão). Host em espera por ${Math.ceil(cooldownRemainingMs(host) / 1000)}s.`);
            throw rateLimitedError(Math.ceil(cooldownRemainingMs(host) / 1000));
          }
          if (mkvErr?.preferFfmpeg) {
            fileSizeForSpeed = typeof mkvErr.totalSize === 'number' ? mkvErr.totalSize : null;
            console.log(`[Subtitle] ↪ CDN sem multi-range: ler o arquivo com o FFmpeg sai mais barato para a faixa ${trackLabel} (estimativa de ${ffmpegMbpsFor(host).toFixed(0)} MB/s para ${host}).`);
          } else {
            console.warn(`[Subtitle] ⚠️ mkv_extractor não conseguiu processar faixa ${trackLabel} (${mkvErr.message?.slice(0, 150)}). Acionando fallback FFmpeg...`);
          }
        }
      }

      // Local validation/conversion/publication is outside the remote fallback boundary.
      if (nativeContent !== undefined) {
        if (nativeFormat === 'srt') {
          subtitleProgress.set(hash, track, 'converting');
          try {
            nativeContent = await convertLocalSrt(nativeFile, tmpFile, extractionKey);
          } catch (error: any) {
            if (error?.code !== 'busy') error.code = 'LOCAL_SUBTITLE_CONVERSION_FAILED';
            throw error;
          }
        }
        publishSubtitle(hash, track, nativeContent, nativeFormat === 'srt' ? 'native-srt' : 'native-ass');
        return nativeContent;
      }

      // 2. Fallback resiliente com FFmpeg completo
      console.log(`[Subtitle] 🔄 Iniciando extração de compatibilidade via FFmpeg para faixa ${trackLabel}...`);
      subtitleProgress.set(hash, track, 'extracting');

      const subCodecArgs = (subCodec.includes('ass') || subCodec.includes('ssa'))
        ? ['-c:s', 'copy']
        : ['-c:s', 'ass'];

      const args = [
        '-hide_banner',
        '-v', 'error',
        ...FFMPEG_NET_ONLY,
        '-reconnect', '1',
        '-reconnect_at_eof', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\nAccept-Encoding: identity\r\n',
        '-multiple_requests', '1',
        '-probesize', '32M',
        '-analyzeduration', '10M',
        '-i', streamUrl,
        '-vn',
        '-an',
        '-dn',
        '-map', `0:${track}`,
        ...subCodecArgs,
        '-f', 'ass',
        '-y',
        tmpFile,
      ];

      return await new Promise<string>((resolve, reject) => {
        const proc = spawnLimited(ffmpegBin(), args);
        if (!proc) {
          const busy: any = new Error('Servidor ocupado (limite de processos).');
          busy.code = 'busy';
          reject(busy);
          return;
        }
        const ffmpegStartedAt = Date.now();
        let stderr = '';
        let finished = false;
        proc.stderr?.on('data', (d) => stderr += d.toString());
        proc.on('error', (err) => { finished = true; clearTimeout(timer); reject(err); });

        activeSubtitleProcesses.set(extractionKey, () => {
          try {
            console.log(`[Subtitle] ⏹ Cancelando extração da faixa ${trackLabel} (processo descartado/obsoleto)...`);
            killTree(proc);
          } catch {}
        });

        const timer = setTimeout(() => {
          finished = true;
          killTree(proc);
          const timeoutErr: any = new Error('Tempo limite de 480s excedido ao extrair legenda individual.');
          timeoutErr.code = 'EXTRACTION_FAILED';
          reject(timeoutErr);
        }, 480000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          activeSubtitleProcesses.delete(extractionKey);
          if (finished) return;
          finished = true;
          if (code === 0) {
            try {
              const content = readSubtitleOutput(tmpFile);
              publishSubtitle(hash, track, content, 'ffmpeg');
              console.log(`[Subtitle] ✅ Legenda ${trackLabel} extraída com sucesso (${content.length} bytes).`);
              // O FFmpeg leu o arquivo todo: guarda a velocidade real deste CDN para as próximas decisões
              if (fileSizeForSpeed) recordFfmpegRead(host, fileSizeForSpeed, Date.now() - ffmpegStartedAt);
              resolve(content);
            } catch (error) {
              reject(error);
            }
          } else {
            try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
            console.warn(`[Subtitle] Falha ao extrair ${trackLabel} (code ${code}): ${stderr}`);
            if (/429 Too Many Requests/i.test(stderr)) {
              noteRateLimited(host);
              reject(rateLimitedError(Math.ceil(cooldownRemainingMs(host) / 1000)));
              return;
            }
            const err: any = new Error(`Falha ao extrair legenda #${track}: ${stderr.slice(-300) || 'Erro no processo FFmpeg'}`);
            err.code = 'EXTRACTION_FAILED';
            reject(err);
          }
        });
      });
      });
      gateBumps.set(extractionKey, gated.bump);
      const content = await gated.promise;
      subtitleProgress.set(hash, track, 'ready');
      return content;
    } catch (error: any) {
      if (error?.code === 'UPSTREAM_RATE_LIMITED') {
        subtitleProgress.set(hash, track, 'waiting_cdn', { retryAt: Date.now() + error.retryAfter * 1000, errorCode: error.code, active: false });
      } else {
        subtitleProgress.set(hash, track, 'failed', { errorCode: error?.code || 'EXTRACTION_FAILED' });
      }
      throw error;
    } finally {
      clearInterval(gateWaitTimer);
      for (const file of temporaryFiles) { try { fs.unlinkSync(file); } catch {} }
      pendingSubtitleExtractions.delete(extractionKey);
      activeSubtitleProcesses.delete(extractionKey);
      gateBumps.delete(extractionKey);
      interactiveWanted.delete(extractionKey);
    }
  })();

  pendingSubtitleExtractions.set(extractionKey, extractionPromise);
  return await extractionPromise;
}

/**
 * Obtém a legenda instantaneamente do cache em disco (0ms) ou extrai individualmente sob demanda
 */
export async function getOrExtractSubtitle(targetUrl: string, track: string, customFingerprint?: string, opts: { prefetch?: boolean } = {}): Promise<string> {
  const hash = getMediaFingerprint(targetUrl, customFingerprint);
  const cached = readCachedSubtitle(hash, track);
  if (cached !== null) {
    subtitleProgress.set(hash, track, 'ready');
    warmFonts(targetUrl, customFingerprint);
    return cached;
  }

  // Extração pontual exclusiva da faixa selecionada
  const content = await extractSubtitleTrack(targetUrl, track, customFingerprint, Boolean(opts.prefetch));
  // A legenda ficou pronta: a leitura das fontes (bloco Attachments) já começa, sem esperar o player pedir o mapa
  warmFonts(targetUrl, customFingerprint);
  return content;
}
