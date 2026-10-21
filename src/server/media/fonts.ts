import fs from 'node:fs';
import path from 'node:path';
import { spawnLimited } from '../limits';
import { ffmpegBin, killTree } from '../tools';
import { mapAttachmentOrdinals, placeAttachments, readAttachments } from './attachments';
import { FFMPEG_NET_ONLY } from './ffmpeg';
import { indexFonts, readNamesIndex } from './fontCache';
import { getMediaFingerprint } from './fingerprint';
import { FONT_CACHE_DIR } from './paths';
import { resolveFinalCdnUrl } from './resolver';
import { tracksCache } from './tracks';
import { hostOf, runOnHost, type GatePriority } from './upstreamGate';

const pendingFontExtractions = new Map<string, Promise<void>>();

const extOf = (name: string) => /\.(ttf|otf|woff2|ttc)$/i.exec(name)?.[1].toLowerCase() || 'ttf';

/**
 * Extrai de uma vez todas as fontes anexadas que o /api/tracks já listou (mais a pedida, se houver) para `targetDir`,
 * indexa os nomes e deduplica por conteúdo. Pedidos simultâneos da mesma mídia esperam a mesma extração.
 */
export async function ensureFonts(
  targetUrl: string,
  hash: string,
  targetDir: string,
  requested?: { idx: string; name: string },
  priority: GatePriority = 'interactive'
): Promise<void> {
  const inFlight = pendingFontExtractions.get(hash);
  if (inFlight) {
    await inFlight;
    return;
  }
  const extractionPromise = (async () => {
    const streamUrl = await resolveFinalCdnUrl(targetUrl);
    // Extrai de uma vez todos os anexos que o /api/tracks já listou (e o pedido atual)
    const wanted = new Map<string, string>();
    if (requested) wanted.set(requested.idx, requested.name);
    for (const f of tracksCache.get(targetUrl)?.fonts || []) {
      if (Number.isInteger(f.index)) wanted.set(String(f.index), f.filename || '');
    }
    console.log(`[FontExtractor] Extraindo ${wanted.size} fonte(s) anexada(s) do MKV (Media: ${hash})...`);

    // 1) Caminho rápido: só o bloco Attachments do MKV (1 requisição), sem o FFmpeg percorrer o arquivo
    const markAttempted = () => {
      for (const idx of wanted.keys()) {
        try {
          fs.writeFileSync(path.join(targetDir, `f${idx}.done`), new Date().toISOString());
        } catch {
          // ignore
        }
      }
    };
    const host = hostOf(streamUrl);
    const fastStarted = Date.now();
    try {
      const entries = await runOnHost(host, priority, () => readAttachments(streamUrl, targetDir)).promise;
      const knownIdx = (tracksCache.get(targetUrl)?.fonts || []).map((f: any) => f.index).filter(Number.isInteger);
      const ordinals = mapAttachmentOrdinals(wanted, knownIdx, entries);
      const finalNames = new Map<number, string>();
      for (const [idx, ordinal] of ordinals) finalNames.set(ordinal, `f${idx}.${extOf(wanted.get(idx) || '')}`);
      placeAttachments(targetDir, entries, finalNames);
      for (const idx of ordinals.keys()) wanted.delete(idx);
      console.log(`[FontExtractor] ${ordinals.size} fonte(s) lida(s) do bloco Attachments em ${Date.now() - fastStarted}ms`);
    } catch (err: any) {
      if (err?.code === 'busy') throw err;
      console.warn(`[FontExtractor] Leitura direta dos anexos falhou, usando o FFmpeg: ${String(err?.message || err).slice(0, 160)}`);
    }
    if (wanted.size === 0) {
      markAttempted();
      return;
    }

    // 2) Fallback: o FFmpeg extrai o que o caminho rápido não cobriu
    const dumpArgs: string[] = [];
    for (const [idx, name] of wanted) {
      dumpArgs.push(`-dump_attachment:${idx}`, path.join(targetDir, `f${idx}.${extOf(name)}`));
    }
    const args = [
      '-hide_banner',
      '-v', 'error',
      '-y',
      ...FFMPEG_NET_ONLY,
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
      ...dumpArgs,
      '-i', streamUrl,
    ];

    await runOnHost(hostOf(streamUrl), priority, () => new Promise<void>((resolve, reject) => {
      const proc = spawnLimited(ffmpegBin(), args, { cwd: targetDir });
      if (!proc) {
        const busy: any = new Error('Servidor ocupado (limite de processos).');
        busy.code = 'busy';
        reject(busy);
        return;
      }
      const timer = setTimeout(() => {
        killTree(proc);
      }, 120000);
      proc.on('close', () => {
        clearTimeout(timer);
        // Marca cada índice como já tentado para nunca mais reexecutar o FFmpeg por ele
        markAttempted();
        resolve();
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    })).promise;
  })().finally(() => {
    indexFonts(targetDir);
  });

  pendingFontExtractions.set(hash, extractionPromise);
  try {
    await extractionPromise;
  } finally {
    pendingFontExtractions.delete(hash);
  }
}

/**
 * Começa a extrair as fontes de uma mídia em segundo plano (as que o /api/tracks listou e ainda não estão em disco).
 * Chamada assim que a legenda fica pronta: quando o player pede o mapa de fontes, a leitura do bloco Attachments já está
 * em andamento ou concluída. Entra no portão como pré-extração (não passa na frente do que o usuário pediu).
 */
export function warmFonts(targetUrl: string, customFingerprint?: string): void {
  const listed: number[] = (tracksCache.get(targetUrl)?.fonts || []).map((f: any) => f.index).filter(Number.isInteger);
  if (listed.length === 0) return;
  const hash = getMediaFingerprint(targetUrl, customFingerprint);
  const targetDir = path.join(FONT_CACHE_DIR, hash);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const index = readNamesIndex(targetDir);
    if (listed.every((idx) => index[String(idx)] || fs.existsSync(path.join(targetDir, `f${idx}.done`)))) return;
  } catch {
    return;
  }
  ensureFonts(targetUrl, hash, targetDir, undefined, 'prefetch').catch(() => {
    // o pedido do player (/api/fontmap ou /api/font) repete a extração e trata o erro
  });
}
