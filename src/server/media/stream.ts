import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { sendApiError } from '../http';
import { checkUrlSyntax, isBlockedError, safeHttpAgent, safeHttpsAgent } from '../security';
import { cacheResolved, invalidateResolvedUrl } from './resolver';

/**
 * Streaming direto com HTTP 206 Partial Content, suporte a Range e redirecionamento de links Debrid/Torrentio.
 *
 * `hop` numera os saltos de redirect só para o log ficar legível; a lógica de redirecionamento
 * continua igual (mesmo limite de saltos, mesma revalidação de segurança a cada um).
 */
export function pipeMediaStreamDirect(
  actualUrl: string,
  targetUrl: string,
  req: any,
  res: any,
  redirectsLeft = 5,
  hop = 0
) {
  // Cronômetro do salto ANTES de abrir a conexão: é daqui que sai o tempo de DNS+TCP+TLS+resposta
  const hopStartedAt = performance.now();
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
          pipeMediaStreamDirect(nextUrl, targetUrl, req, res, redirectsLeft - 1, hop + 1);
          return;
        }

        // Se o token ou CDN expirou/falhou (400, 401, 403, 404, 410) e tínhamos URL em cache,
        // volta para a URL de ORIGEM para obter uma URL assinada nova.
        if (
          upstreamRes.statusCode &&
          upstreamRes.statusCode >= 400 &&
          upstreamRes.statusCode < 500 &&
          actualUrl !== targetUrl
        ) {
          console.warn(
            `[MediaProxy] Upstream respondeu ${upstreamRes.statusCode} para a URL já resolvida (hop ${hop}). ` +
              'Invalidando o cache e renovando pela URL de origem...'
          );
          invalidateResolvedUrl(targetUrl);
          upstreamRes.resume();
          pipeMediaStreamDirect(targetUrl, targetUrl, req, res, redirectsLeft - 1, hop + 1);
          return;
        }

        // A própria URL de origem JÁ é a URL assinada (não houve redirect para um CDN): se ela
        // expirou, não existe para onde renovar dentro desta requisição. O certo é devolver o
        // 4xx ao cliente e ainda derrubar a entrada do cache — senão a URL morta continuaria
        // servindo até o TTL expirar e todo playback receberia 403 sem chance de se recuperar.
        if (
          upstreamRes.statusCode &&
          upstreamRes.statusCode >= 400 &&
          upstreamRes.statusCode < 500 &&
          actualUrl === targetUrl
        ) {
          console.warn(
            `[MediaProxy] Upstream respondeu ${upstreamRes.statusCode} e a URL de origem é a própria ` +
              'URL assinada (sem redirect para renovar). Invalidando o cache e repassando o erro ao cliente.'
          );
          invalidateResolvedUrl(targetUrl);
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

        // Métricas do trecho, sem URL/token: só o que ajuda a achar buffer/stall.
        //
        // Tempos medidos de propósito, porque diagnosticar buffering exige separá-los:
        //   connectToHeaders: DNS + TCP + TLS + ida até o upstream devolver os cabeçalhos
        //                     (o TTFB no sentido HTTP: o primeiro byte da resposta SÃO os headers)
        //   headersToFirstByte: quanto o upstream demorou para começar a entregar o corpo
        //   upstreamTotal: do request ao `end` do upstream
        //   flushedToClient: do request ao `finish` da resposta (tudo entregue ao cliente)
        const headersAt = performance.now();
        let firstBodyByteAt = 0;
        let bytes = 0;
        const requestedRange = typeof req.headers['range'] === 'string' ? req.headers['range'] : '';
        const totalBytes = Number(upstreamRes.headers['content-length'] || 0);
        upstreamRes.on('data', (chunk: any) => {
          bytes += chunk.length;
          if (!firstBodyByteAt) firstBodyByteAt = performance.now();
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

        const ms = (from: number, to: number) => `${Math.max(0, to - from).toFixed(1)}ms`;

        // Desfechos distintos, porque "o upstream acabou" NÃO é "o cliente recebeu tudo":
        //
        //   upstreamEnd    o upstream fechou o corpo (pode ainda estar no buffer do socket)
        //   flushed        `finish`: a resposta foi integralmente entregue ao cliente  <- o normal
        //   cancelado      o cliente sumiu antes disso (seek, fechar a aba, trocar de fonte)
        //   erro           upstream ou socket quebraram
        //
        // O `close` sem `finish` é a única prova real de cancelamento. Checar
        // `writableFinished` dentro do `end` do upstream marcava transferências normais como
        // abortadas, porque no `end` o Node ainda pode estar drenando o que já leu.
        let outcome: 'completo' | 'cancelado' | 'erro' | null = null;
        let reported = false;
        let pendingOutboundAt = 0;
        const report = () => {
          if (reported) return;
          // Só um `close` que chegou depois do `finish` conta como cancelamento.
          if (!outcome) outcome = res.writableFinished ? 'completo' : 'cancelado';
          reported = true;
          const endedAt = performance.now();
          const elapsedMs = Math.max(0.1, endedAt - hopStartedAt);
          const mbps = +((bytes * 8) / elapsedMs / 1000).toFixed(1);
          // `upstreamTotal` só é conhecido se o upstream chegou a terminar.
          const upstreamTotal = upstreamEndedAt ? ms(hopStartedAt, upstreamEndedAt) : 'n/a';
          console.log(
            `[MediaStream] hop=${hop} desfecho=${outcome} status=${upstreamRes.statusCode} ` +
              `range="${requestedRange || 'none'}" ` +
              `contentRange="${upstreamRes.headers['content-range'] || ''}" ` +
              `connectToHeaders=${ms(hopStartedAt, headersAt)} ` +
              `headersToFirstByte=${firstBodyByteAt ? ms(headersAt, firstBodyByteAt) : 'n/a'} ` +
              `upstreamTotal=${upstreamTotal} ` +
              `total=${elapsedMs.toFixed(1)}ms bytes=${bytes} totalBytes=${totalBytes || 'chunked'} ` +
              `${mbps}Mbps${pendingOutboundAt ? ` [no socket: ${Math.round(pendingOutboundAt / 1024)}KiB]` : ''}`
          );
        };

        let upstreamEndedAt = 0;
        upstreamRes.on('end', () => {
          upstreamEndedAt = performance.now();
          // Não reporta aqui: pode ainda haver bytes no caminho até o cliente.
          // Quem fecha o relatório é o `finish` (entregue) ou o `close` sem `finish` (cancelado).
        });
        upstreamRes.on('error', (err: any) => {
          console.warn(`[MediaProxy] Corpo do upstream quebrou: ${err?.message}`);
          outcome = 'erro';
          report();
        });
        res.on('finish', () => {
          if (!outcome) outcome = 'completo';
          report();
        });
        res.on('close', () => {
          // `finish` já tendo disparado = resposta entregue por inteiro: `close` é só limpeza.
          if (res.writableFinished) return;
          if (!outcome) outcome = 'cancelado';
          // Quanto ficou preso no socket do Node, sem conseguir sair para o cliente.
          pendingOutboundAt = res.writableLength ? performance.now() - hopStartedAt : 0;
          report();
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
