import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.ALLOW_PRIVATE_URLS = '1';

const { ORIGIN_RETRIES, resolveFinalCdnUrl, resolvedUrlCache } = await import('../media/resolver');
const { resetGateForTests } = await import('../media/upstreamGate');

/**
 * O resolvedor de origem (Torrentio/torrentsdb) responde 429 quando um vídeo novo chega junto com outras requisições.
 * A sondagem espera o Retry-After e repete; as demais requisições do mesmo vídeo aguardam essa mesma resposta.
 */

let servers: http.Server[] = [];
async function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

beforeEach(() => {
  resolvedUrlCache.clear();
  resetGateForTests();
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

describe('429 na origem do vídeo', () => {
  it('espera o Retry-After, repete a sondagem e guarda o CDN quando a origem libera', async () => {
    let hits = 0;
    const cdn = await listen((_req, res) => {
      res.writeHead(206, { 'Content-Range': 'bytes 0-0/10', 'Content-Length': '1' });
      res.end('x');
    });
    const origin = await listen((_req, res) => {
      hits++;
      if (hits <= 2) {
        res.writeHead(429, { 'Retry-After': '1', 'Content-Length': '0' });
        res.end();
        return;
      }
      res.writeHead(302, { Location: `${cdn}/signed/video.mkv` });
      res.end();
    });
    const url = `${origin}/resolve/novo.mkv`;

    const started = Date.now();
    const finalUrl = await resolveFinalCdnUrl(url);
    expect(finalUrl).toBe(`${cdn}/signed/video.mkv`);
    expect(resolvedUrlCache.get(url)).toBe(finalUrl);
    expect(hits).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900); // duas esperas de 1 s
  }, 15_000);

  it('requisições simultâneas do mesmo vídeo novo dividem uma sondagem só', async () => {
    let hits = 0;
    const origin = await listen((_req, res) => {
      hits++;
      if (hits === 1) {
        res.writeHead(429, { 'Retry-After': '1', 'Content-Length': '0' });
        res.end();
        return;
      }
      res.writeHead(206, { 'Content-Range': 'bytes 0-0/10', 'Content-Length': '1' });
      res.end('x');
    });
    const url = `${origin}/resolve/novo.mkv`;
    const results = await Promise.all([resolveFinalCdnUrl(url), resolveFinalCdnUrl(url), resolveFinalCdnUrl(url)]);
    expect(new Set(results).size).toBe(1);
    expect(hits).toBe(2); // 1 tentativa recusada + 1 que passou, para os três
  }, 15_000);

  it('se a origem não liberar, desiste depois das repetições e não guarda nada', async () => {
    let hits = 0;
    const origin = await listen((_req, res) => {
      hits++;
      res.writeHead(429, { 'Retry-After': '1', 'Content-Length': '0' });
      res.end();
    });
    const url = `${origin}/resolve/novo.mkv`;
    expect(await resolveFinalCdnUrl(url)).toBe(url);
    expect(hits).toBe(ORIGIN_RETRIES + 1);
    expect(resolvedUrlCache.has(url)).toBe(false);
  }, 20_000);
});
