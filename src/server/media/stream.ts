import http from 'node:http';
import https from 'node:https';
import { sendApiError } from '../http';
import { checkUrlSyntax, isBlockedError, safeHttpAgent, safeHttpsAgent } from '../security';
import { cacheResolved, invalidateResolvedUrl } from './resolver';

/**
 * Streaming direto com HTTP 206 Partial Content, suporte a Range e redirecionamento de links Debrid/Torrentio.
 */
export function pipeMediaStreamDirect(
  actualUrl: string,
  targetUrl: string,
  req: any,
  res: any,
  redirectsLeft = 5
) {
  try {
    // Cada salto (inclusive redirecionamentos) passa por aqui: esquema e IP literal checados agora,
    // DNS checado na conexão pelo agente seguro
    const parsedUrl = checkUrlSyntax(actualUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    const agent = isHttps ? safeHttpsAgent : safeHttpAgent;

    const reqHeaders: Record<string, string | string[]> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      // Sem `identity`, um upstream com gzip/pe br responses traria o corpo recomprimido: com
      // Content-Range isso quebra o byte offset do player. O vídeo tem de chegar como veio.
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive',
    };

    if (req.headers['range']) {
      reqHeaders['range'] = req.headers['range'];
    }

    const proxyReq = client.request(
      parsedUrl,
      {
        method: req.method || 'GET',
        headers: reqHeaders,
        agent,
      },
      (upstreamRes) => {
        // Redirecionamentos (301, 302, 303, 307, 308) comuns em Torrentio /resolve
        if (
          upstreamRes.statusCode &&
          [301, 302, 303, 307, 308].includes(upstreamRes.statusCode) &&
          upstreamRes.headers.location
        ) {
          if (redirectsLeft <= 0) {
            res.statusCode = 508;
            res.end('Too many redirects');
            return;
          }
          const nextUrl = new URL(upstreamRes.headers.location, actualUrl).href;
          cacheResolved(targetUrl, nextUrl);
          upstreamRes.resume();
          pipeMediaStreamDirect(nextUrl, targetUrl, req, res, redirectsLeft - 1);
          return;
        }

        // Se o token ou CDN expirou/falhou (400, 401, 403, 404, 410) e tínhamos URL em cache, revalida com a original
        if (
          upstreamRes.statusCode &&
          upstreamRes.statusCode >= 400 &&
          upstreamRes.statusCode < 500 &&
          actualUrl !== targetUrl
        ) {
          console.warn(`[MediaProxy] Upstream CDN retornou status ${upstreamRes.statusCode}. Invalidando cache da CDN e renovando com URL original...`);
          invalidateResolvedUrl(targetUrl);
          upstreamRes.resume();
          pipeMediaStreamDirect(targetUrl, targetUrl, req, res, redirectsLeft - 1);
          return;
        }

        if (upstreamRes.statusCode && upstreamRes.statusCode >= 400) {
          let errBody = '';
          upstreamRes.on('data', (d: any) => { errBody += d.toString(); });
          upstreamRes.on('end', () => {
            console.error(`[MediaProxy] ❌ Servidor upstream retornou erro ${upstreamRes.statusCode}: ${errBody.slice(0, 300)}`);
          });
        }

        if (actualUrl !== targetUrl && upstreamRes.statusCode && upstreamRes.statusCode < 400) {
          cacheResolved(targetUrl, actualUrl);
        }

        const outHeaders: Record<string, any> = {
          'Accept-Ranges': 'bytes',
          'X-Content-Type-Options': 'nosniff',
          // Mesmo que o upstream devolva HTML, o navegador não executa nada vindo deste endpoint
          'Content-Security-Policy': 'sandbox',
        };

        const passHeaders = [
          'content-type',
          'content-length',
          'content-range',
          'etag',
          'last-modified',
          'content-disposition',
        ];

        for (const h of passHeaders) {
          const val = upstreamRes.headers[h];
          if (val !== undefined) {
            outHeaders[h] = val;
          }
        }

        const currentType = upstreamRes.headers['content-type'] as string;
        if (!currentType || currentType === 'application/octet-stream' || currentType.includes('matroska') || targetUrl.toLowerCase().includes('.mkv')) {
          outHeaders['content-type'] = 'video/mp4';
        } else if (targetUrl.toLowerCase().includes('.webm')) {
          outHeaders['content-type'] = 'video/webm';
        } else if (!/^(video|audio)\//i.test(currentType)) {
          // text/html & cia nunca saem deste endpoint com o tipo original (evita XSS na origem do app)
          outHeaders['content-type'] = 'application/octet-stream';
        }

        res.writeHead(upstreamRes.statusCode || 200, outHeaders);

        if (req.method === 'HEAD') {
          upstreamRes.resume();
          res.end();
          return;
        }

        // Métricas do trecho: sem URL (pode ter token), só o que ajuda a achar buffer/stall.
        const startedAt = Date.now();
        let bytes = 0;
        let firstByteAt = 0;
        const requestedRange = typeof req.headers['range'] === 'string' ? req.headers['range'] : '';
        const totalBytes = Number(upstreamRes.headers['content-length'] || 0);
        upstreamRes.on('data', (chunk: any) => {
          bytes += chunk.length;
          if (!firstByteAt) firstByteAt = Date.now();
        });

        upstreamRes.pipe(res);

        const cleanUp = () => {
          try {
            proxyReq.destroy();
            upstreamRes.destroy();
          } catch {}
        };

        res.on('close', cleanUp);
        res.on('error', cleanUp);

        const report = (how: string) => {
          const elapsed = Math.max(1, Date.now() - startedAt);
          const mbps = +((bytes * 8) / elapsed / 1000).toFixed(1);
          console.log(
            `[MediaStream] ${how} status=${upstreamRes.statusCode} range="${requestedRange || 'none'}" ` +
              `contentRange="${upstreamRes.headers['content-range'] || ''}" ` +
              `ttfb=${firstByteAt ? firstByteAt - startedAt : -1}ms bytes=${bytes} ` +
              `total=${totalBytes || 'chunked'} elapsed=${elapsed}ms ${mbps}Mbps${res.writableFinished ? '' : ' [abortado]'}`
          );
        };
        upstreamRes.on('end', () => report('completo'));
        res.on('close', () => {
          if (!res.writableFinished) report('cancelado');
        });
      }
    );

    proxyReq.on('error', (err: any) => {
      console.warn('[MediaProxy] Falha ao falar com o upstream:', err?.message);
      if (!res.headersSent) {
        if (isBlockedError(err)) sendApiError(res, 403, 'url_blocked');
        else sendApiError(res, 502, 'upstream_failed');
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    req.on('close', () => {
      try {
        proxyReq.destroy();
      } catch {}
    });

    proxyReq.end();
  } catch (err: any) {
    if (isBlockedError(err)) {
      sendApiError(res, 403, 'url_blocked');
    } else {
      console.error('[MediaProxy] Erro ao montar a requisição:', err);
      sendApiError(res, 500, 'internal');
    }
  }
}
