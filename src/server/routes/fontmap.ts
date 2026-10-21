import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { sendApiError, sendJson } from '../http';
import { isBlockedError } from '../security';
import { indexFonts, readNamesIndex } from '../media/fontCache';
import { getMediaFingerprint } from '../media/fingerprint';
import { FONT_CACHE_DIR } from '../media/paths';
import { tracksCache } from '../media/tracks';
import { ensureFonts } from '../media/fonts';

/**
 * GET /api/fontmap?url=…&fingerprint=… — para cada fonte anexada ao MKV, os nomes pelos quais uma legenda pode pedi-la
 * (família, nome completo, PostScript), em minúsculas. O player cruza isso com as fontes que o ASS usa e carrega só
 * essas, em vez das ~24 anexadas (~46 MB por pessoa). `null` = nomes desconhecidos (WOFF2, falha na leitura): o player
 * carrega essa fonte por garantia. `complete: false` = as faixas ainda não foram listadas (o player carrega todas).
 * Extrai as fontes se ainda não estiverem em disco (a mesma extração que o /api/font faria).
 */
export async function handleFontMap(req: IncomingMessage, res: ServerResponse) {
  try {
    const reqUrl = new URL(req.url || '', 'http://localhost');
    const targetUrl = reqUrl.searchParams.get('url');
    const customFingerprint = (reqUrl.searchParams.get('fingerprint') || '').slice(0, 200) || undefined;
    if (!targetUrl) {
      sendApiError(res, 400, 'bad_request', 'Parâmetro url é obrigatório.');
      return;
    }

    const listed: number[] = (tracksCache.get(targetUrl)?.fonts || []).map((f: any) => f.index).filter(Number.isInteger);
    const known = tracksCache.get(targetUrl);
    res.setHeader('Cache-Control', 'no-store');
    if (!known) {
      sendJson(res, 200, { complete: false, fonts: {} });
      return;
    }
    if (listed.length === 0) {
      sendJson(res, 200, { complete: true, fonts: {} });
      return;
    }

    const hash = getMediaFingerprint(targetUrl, customFingerprint);
    const targetDir = path.join(FONT_CACHE_DIR, hash);
    fs.mkdirSync(targetDir, { recursive: true });

    const attempted = (idx: number) => fs.existsSync(path.join(targetDir, `f${idx}.done`));
    // Indexa o que já está em disco (fontes extraídas antes de existir o índice entram aqui, e são deduplicadas)
    let index = indexFonts(targetDir);
    if (listed.some((idx) => !index[String(idx)] && !attempted(idx))) {
      await ensureFonts(targetUrl, hash, targetDir);
      index = readNamesIndex(targetDir);
    }

    const fonts: Record<string, string[] | null> = {};
    for (const idx of listed) fonts[String(idx)] = index[String(idx)]?.names ?? null;
    sendJson(res, 200, { complete: true, fonts });
  } catch (err: any) {
    if (isBlockedError(err)) {
      sendApiError(res, 403, 'url_blocked');
    } else if (err?.code === 'busy') {
      res.setHeader('Retry-After', '5');
      sendApiError(res, 503, 'busy');
    } else {
      console.error('[FontMap] Erro:', err?.message);
      sendApiError(res, 500, 'internal');
    }
  }
}
