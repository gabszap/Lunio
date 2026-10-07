import fs from 'node:fs';
import path from 'node:path';
import { touchCacheFile } from '../cleanup';
import { config } from '../config';
import { spawnLimited } from '../limits';
import { ffmpegBin, getTools, killTree } from '../tools';
import { FFMPEG_NET_ONLY } from './ffmpeg';
import { getMediaFingerprint } from './fingerprint';
import { SUB_CACHE_DIR } from './paths';
import { resolveFinalCdnUrl } from './resolver';
import { tracksCache } from './tracks';

const pendingSubtitleExtractions = new Map<string, Promise<string>>();
const activeSubtitleProcesses = new Map<string, () => void>();

/** A extração remota (HTTP Range) falha por motivos passageiros (CDN lenta, conexão cortada): tenta algumas vezes antes do FFmpeg. */
const REMOTE_ATTEMPT_TIMEOUT_MS = 40_000;
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
  extractionKey: string
): Promise<string> {
  const args = [
    '-u',
    '-m', 'mkv_extractor',
    streamUrl,
    // Índice de stream do FFmpeg (o mesmo do /api/tracks), não o TrackNumber do Matroska
    '--stream-index', String(track),
    '-o', outputFile,
    '--json',
  ];

  return await new Promise<string>((resolve, reject) => {
    const py = getTools().python;
    if (!py.found) {
      reject(new Error('Python 3.10+ não encontrado.'));
      return;
    }
    const proc = spawnLimited(py.command, [...py.args, ...args], {
      cwd: config.rootDir,
    });
    if (!proc) {
      const busy: any = new Error('Servidor ocupado (limite de processos).');
      busy.code = 'busy';
      reject(busy);
      return;
    }
    let stderr = '';
    let stdout = '';
    proc.stderr?.on('data', (d) => stderr += d.toString());
    proc.stdout?.on('data', (d) => stdout += d.toString());
    proc.on('error', (err) => {
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
      killTree(proc);
      reject(new Error(`Tempo limite de ${REMOTE_ATTEMPT_TIMEOUT_MS / 1000}s excedido no mkv_extractor.`));
    }, REMOTE_ATTEMPT_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 50) {
        try {
          const content = fs.readFileSync(outputFile, 'utf-8');
          resolve(content);
        } catch (err: any) {
          reject(err);
        }
      } else {
        const errMsg = (stderr || stdout || '').trim();
        reject(new Error(`mkv_extractor finalizou com código ${code}: ${errMsg.slice(-300)}`));
      }
    });
  });
}

/**
 * Extração individual resiliente: mkv_extractor primeiro, FFmpeg como fallback
 */
async function extractSubtitleTrack(targetUrl: string, track: string, customFingerprint?: string): Promise<string> {
  const hash = getMediaFingerprint(targetUrl, customFingerprint);
  // Prefixo "s" = índice de stream do FFmpeg. O cache antigo ("_track") podia conter a faixa vizinha (bug de índice).
  const cacheFile = path.join(SUB_CACHE_DIR, `${hash}_s${track}.ass`);

  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 100) {
    touchCacheFile(cacheFile);
    return fs.readFileSync(cacheFile, 'utf-8');
  }

  // Remove arquivo corrompido ou incompleto com 0 bytes
  if (fs.existsSync(cacheFile)) {
    try { fs.unlinkSync(cacheFile); } catch {}
  }

  const extractionKey = `${hash}_${track}`;
  if (pendingSubtitleExtractions.has(extractionKey)) {
    return await pendingSubtitleExtractions.get(extractionKey)!;
  }

  const extractionPromise = (async () => {
    try {
      const streamUrl = await resolveFinalCdnUrl(targetUrl);
      const cachedTracks = tracksCache.get(targetUrl);
      const subInfo = cachedTracks?.subtitles?.find((s: any) => String(s.index) === String(track));
      const subCodec = (subInfo?.codec || '').toLowerCase();

      // Se for formato bitmap (PGS, VobSub), rejeita com código específico para o resolver dar fallback
      if (subCodec === 'none' || /pgs|pgssub|dvd_sub|dvb_sub|xsub|dvdsub|vobsub|bitmap/i.test(subCodec)) {
        const err: any = new Error('Formato bitmap/PGS não suporta extração direta de texto.');
        err.code = 'BITMAP_NOT_SUPPORTED';
        throw err;
      }

      const tmpFile = path.join(SUB_CACHE_DIR, `${hash}_track${track}_${Date.now()}.tmp`);

      // 1. Tenta primeiro extração remota ultrarrápida via HTTP Range (módulo mkv_extractor)
      const isCandidateMkv = targetUrl.toLowerCase().includes('.mkv') ||
                             streamUrl.toLowerCase().includes('.mkv') ||
                             subCodec.includes('ass') ||
                             subCodec.includes('ssa');

      if (isCandidateMkv) {
        try {
          console.log(`[Subtitle] 🚀 Tentando extração remota ultrarrápida (HTTP Range / EBML) para faixa #${track}...`);
          const t0 = Date.now();
          let content = '';
          for (let attempt = 1; ; attempt++) {
            try {
              content = await extractRemoteMkvSubtitle(streamUrl, track, tmpFile, extractionKey);
              break;
            } catch (attemptErr: any) {
              // Sem Python ou servidor ocupado não melhora tentando de novo
              if (attempt >= REMOTE_ATTEMPTS || attemptErr?.code === 'busy' || /Python 3\.10\+ não encontrado/.test(attemptErr?.message || '')) throw attemptErr;
              console.warn(`[Subtitle] ↻ Tentativa ${attempt}/${REMOTE_ATTEMPTS} falhou na faixa #${track} (${attemptErr.message?.slice(0, 100)}). Tentando de novo…`);
              try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
              await new Promise((r) => setTimeout(r, REMOTE_RETRY_DELAY_MS * attempt));
            }
          }

          if (fs.existsSync(tmpFile)) {
            if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
            fs.renameSync(tmpFile, cacheFile);
          }
          const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(`[Subtitle] ⚡ Sucesso! Faixa #${track} extraída via mkv_extractor em ${elapsedSec}s (${content.length} bytes).`);
          return content;
        } catch (mkvErr: any) {
          console.warn(`[Subtitle] ⚠️ mkv_extractor não conseguiu processar faixa #${track} (${mkvErr.message?.slice(0, 150)}). Acionando fallback FFmpeg...`);
          try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
        }
      }

      // 2. Fallback resiliente com FFmpeg completo
      console.log(`[Subtitle] 🔄 Iniciando extração de compatibilidade via FFmpeg para faixa #${track}...`);

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
        let stderr = '';
        proc.stderr?.on('data', (d) => stderr += d.toString());
        proc.on('error', (err) => reject(err));

        activeSubtitleProcesses.set(extractionKey, () => {
          try {
            console.log(`[Subtitle] ⏹ Cancelando extração da faixa #${track} (processo descartado/obsoleto)...`);
            killTree(proc);
          } catch {}
        });

        const timer = setTimeout(() => {
          killTree(proc);
          const timeoutErr: any = new Error('Tempo limite de 480s excedido ao extrair legenda individual.');
          timeoutErr.code = 'EXTRACTION_FAILED';
          reject(timeoutErr);
        }, 480000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          activeSubtitleProcesses.delete(extractionKey);
          if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 50) {
            try {
              if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
              fs.renameSync(tmpFile, cacheFile);
              const content = fs.readFileSync(cacheFile, 'utf-8');
              console.log(`[Subtitle] ✅ Legenda #${track} extraída com sucesso (${content.length} bytes).`);
              resolve(content);
            } catch {
              resolve(fs.readFileSync(tmpFile, 'utf-8'));
            }
          } else {
            try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
            console.warn(`[Subtitle] Falha ao extrair #${track} (code ${code}): ${stderr}`);
            const err: any = new Error(`Falha ao extrair legenda #${track}: ${stderr.slice(-300) || 'Erro no processo FFmpeg'}`);
            err.code = 'EXTRACTION_FAILED';
            reject(err);
          }
        });
      });
    } finally {
      pendingSubtitleExtractions.delete(extractionKey);
      activeSubtitleProcesses.delete(extractionKey);
    }
  })();

  pendingSubtitleExtractions.set(extractionKey, extractionPromise);
  return await extractionPromise;
}

/**
 * Obtém a legenda instantaneamente do cache em disco (0ms) ou extrai individualmente sob demanda
 */
export async function getOrExtractSubtitle(targetUrl: string, track: string, customFingerprint?: string): Promise<string> {
  const hash = getMediaFingerprint(targetUrl, customFingerprint);
  const cacheFile = path.join(SUB_CACHE_DIR, `${hash}_s${track}.ass`);

  // Se já existe no cache e é válido, responde em 0ms
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 100) {
    touchCacheFile(cacheFile);
    return fs.readFileSync(cacheFile, 'utf-8');
  }

  // Extração pontual exclusiva da faixa selecionada
  return await extractSubtitleTrack(targetUrl, track, customFingerprint);
}
