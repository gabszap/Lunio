import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { touchCacheFile } from '../cleanup';
import { sendApiError } from '../http';
import { spawnLimited } from '../limits';
import { isBlockedError } from '../security';
import { ffmpegBin, killTree } from '../tools';
import { mapAttachmentOrdinals, placeAttachments, readAttachments } from '../media/attachments';
import { FFMPEG_NET_ONLY } from '../media/ffmpeg';
import { getMediaFingerprint } from '../media/fingerprint';
import { FONT_CACHE_DIR } from '../media/paths';
import { resolveFinalCdnUrl } from '../media/resolver';
import { tracksCache } from '../media/tracks';
import { hostOf, runOnHost } from '../media/upstreamGate';

const pendingFontExtractions = new Map<string, Promise<void>>();

/** GET /api/font?url=…&track=… — fonte anexada ao MKV, extraída uma vez e servida do cache. */
export async function handleFont(req: IncomingMessage, res: ServerResponse) {
  try {
    const reqUrl = new URL(req.url || '', 'http://localhost');
    const targetUrl = reqUrl.searchParams.get('url');
    const fontFilename = reqUrl.searchParams.get('name') || '';
    const streamTrack = reqUrl.searchParams.get('track') || '';
    const customFingerprint = (reqUrl.searchParams.get('fingerprint') || '').slice(0, 200) || undefined;

    if (!targetUrl || !/^\d{1,4}$/.test(streamTrack)) {
      sendApiError(res, 400, 'bad_request', 'Parâmetros url e track são obrigatórios.');
      return;
    }

    const hash = getMediaFingerprint(targetUrl, customFingerprint);
    const targetDir = path.join(FONT_CACHE_DIR, hash);
    fs.mkdirSync(targetDir, { recursive: true });

    // O nome do anexo vem do MKV (dado de terceiros, pode ter `..\`). Por isso o FFmpeg grava só em
    // caminhos que o servidor escolhe (f<índice>.<ext>); o nome original serve apenas para a extensão.
    const extOf = (name: string) => /\.(ttf|otf|woff2|ttc)$/i.exec(name)?.[1].toLowerCase() || 'ttf';

    const findCached = (idx: string): string | null => {
      try {
        const name = fs.readdirSync(targetDir).find((f) => f.startsWith(`f${idx}.`) && !f.endsWith('.done'));
        if (!name) return null;
        const full = path.join(targetDir, name);
        const st = fs.statSync(full);
        return st.isFile() && st.size > 100 ? full : null;
      } catch {
        return null;
      }
    };
    const wasAttempted = (idx: string) => fs.existsSync(path.join(targetDir, `f${idx}.done`));

    const serveCachedFont = (filePath: string) => {
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.otf' ? 'font/otf' : (ext === '.woff2' ? 'font/woff2' : 'font/ttf');
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      touchCacheFile(filePath);
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => {
        if (!res.headersSent) sendApiError(res, 500, 'internal');
        else res.end();
      });
      stream.pipe(res);
    };

    const notFound = () => sendApiError(res, 404, 'not_found', 'Fonte não encontrada no container MKV');

    const cached = findCached(streamTrack);
    if (cached) return serveCachedFont(cached);
    if (wasAttempted(streamTrack)) return notFound();

    // Deduplica extrações de fonte simultâneas para a mesma mídia
    const inFlight = pendingFontExtractions.get(hash);
    if (inFlight) {
      await inFlight;
      const afterWait = findCached(streamTrack);
      if (afterWait) return serveCachedFont(afterWait);
      if (wasAttempted(streamTrack)) return notFound();
    }

    const extractionPromise = (async () => {
      const streamUrl = await resolveFinalCdnUrl(targetUrl);
      // Extrai de uma vez todos os anexos que o /api/tracks já listou (e o pedido atual)
      const wanted = new Map<string, string>([[streamTrack, fontFilename]]);
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
        const entries = await runOnHost(host, 'interactive', () => readAttachments(streamUrl, targetDir)).promise;
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

      await runOnHost(hostOf(streamUrl), 'interactive', () => new Promise<void>((resolve, reject) => {
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
    })();

    pendingFontExtractions.set(hash, extractionPromise);
    try {
      await extractionPromise;
    } finally {
      pendingFontExtractions.delete(hash);
    }

    const extracted = findCached(streamTrack);
    if (extracted) return serveCachedFont(extracted);
    notFound();
  } catch (err: any) {
    if (isBlockedError(err)) {
      sendApiError(res, 403, 'url_blocked');
    } else if (err?.code === 'busy') {
      res.setHeader('Retry-After', '5');
      sendApiError(res, 503, 'busy');
    } else {
      console.error('[FontExtractor] Erro:', err?.message);
      sendApiError(res, 500, 'internal');
    }
  }
}
