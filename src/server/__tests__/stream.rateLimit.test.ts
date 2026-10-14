import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.ALLOW_PRIVATE_URLS = '1';
});

const { resolvedUrlCache } = await import('../media/resolver');
const { pipeMediaStreamDirect } = await import('../media/stream');
const { activeStreamCount, cooldownRemainingMs, noteStreamStart, resetGateForTests, runOnHost } = await import('../media/upstreamGate');

/**
 * O TorBox deixa 3 downloads simultâneos por assinatura e responde 429 acima disso. O proxy de vídeo trata isso como
 * espera (repete a mesma URL), não como token expirado, e o stream aberto conta como uma das conexões do host.
 */

let servers: http.Server[] = [];

async function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

/** Servidor do "Lunio": cada pedido do player vira um pipeMediaStreamDirect para `target`. */
async function proxyFor(target: string) {
  return listen((req, res) => pipeMediaStreamDirect(target, target, req, res));
}

beforeEach(() => {
  resolvedUrlCache.clear();
  resetGateForTests();
});

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
  vi.useRealTimers();
});

const ok = (res: http.ServerResponse) => {
  res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-9/100', 'Content-Length': '10' });
  res.end(Buffer.alloc(10, 1));
};

describe('429 do CDN no proxy de vídeo', () => {
  it('espera o Retry-After e repete a mesma URL, sem renovar pela origem', async () => {
    let hits = 0;
    const origin = await listen((_req, res) => {
      hits++;
      if (hits <= 2) {
        res.writeHead(429, { 'Retry-After': '1', 'Content-Length': '0' });
        res.end();
        return;
      }
      ok(res);
    });
    const proxy = await proxyFor(`${origin}/video.mp4`);

    const started = Date.now();
    const res = await fetch(`${proxy}/`, { headers: { Range: 'bytes=0-9' } });
    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(10);
    expect(hits).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900); // duas esperas de 1 s
  }, 15_000);

  it('o 429 põe o host em espera para as extrações de legenda', async () => {
    const origin = await listen((_req, res) => {
      res.writeHead(429, { 'Retry-After': '30', 'Content-Length': '0' });
      res.end();
    });
    const proxy = await proxyFor(`${origin}/video.mp4`);
    const pending = fetch(`${proxy}/`, { headers: { Range: 'bytes=0-9' } }).catch(() => null);
    await new Promise((r) => setTimeout(r, 400));
    expect(cooldownRemainingMs(new URL(origin).host)).toBeGreaterThan(20_000);
    // Cliente desiste (aba fechada): o proxy para de insistir
    await Promise.race([pending, new Promise((r) => setTimeout(r, 100))]);
  }, 10_000);

  it('depois de 3 repetições devolve 503 com Retry-After', async () => {
    let hits = 0;
    const origin = await listen((_req, res) => {
      hits++;
      res.writeHead(429, { 'Retry-After': '1', 'Content-Length': '0' });
      res.end();
    });
    const proxy = await proxyFor(`${origin}/video.mp4`);

    const res = await fetch(`${proxy}/`, { headers: { Range: 'bytes=0-9' } });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(hits).toBe(4); // 1 + 3 repetições
  }, 20_000);

  it('um 429 não derruba a URL guardada (não é token expirado)', async () => {
    let hits = 0;
    const origin = await listen((_req, res) => {
      hits++;
      if (hits === 1) {
        res.writeHead(429, { 'Retry-After': '1', 'Content-Length': '0' });
        res.end();
        return;
      }
      ok(res);
    });
    const url = `${origin}/video.mp4`;
    resolvedUrlCache.set(url, url);
    const proxy = await proxyFor(url);
    const res = await fetch(`${proxy}/`, { headers: { Range: 'bytes=0-9' } });
    expect(res.status).toBe(206);
    await res.arrayBuffer();
    expect(resolvedUrlCache.get(url)).toBe(url);
  }, 15_000);
});

describe('salto intermediário de redirect', () => {
  it('só a resposta final entra no cache; o salto intermediário (ex.: api.torbox.app) não', async () => {
    const cdn = await listen((_req, res) => ok(res));
    const api = await listen((_req, res) => {
      res.writeHead(302, { Location: `${cdn}/signed/video.mp4` });
      res.end();
    });
    const source = `${api}/resolve`;
    const proxy = await proxyFor(source);
    const res = await fetch(`${proxy}/`, { headers: { Range: 'bytes=0-9' } });
    expect(res.status).toBe(206);
    await res.arrayBuffer();
    expect(resolvedUrlCache.get(source)).toBe(`${cdn}/signed/video.mp4`);
  });

  it('se o CDN final der 429 sem parar, o salto intermediário não fica guardado como URL final', async () => {
    const cdn = await listen((_req, res) => {
      res.writeHead(429, { 'Retry-After': '1', 'Content-Length': '0' });
      res.end();
    });
    const api = await listen((_req, res) => {
      res.writeHead(302, { Location: `${cdn}/signed/video.mp4` });
      res.end();
    });
    const source = `${api}/resolve`;
    const proxy = await proxyFor(source);
    const res = await fetch(`${proxy}/`, { headers: { Range: 'bytes=0-9' } });
    expect(res.status).toBe(503);
    expect(resolvedUrlCache.has(source)).toBe(false);
  }, 20_000);
});

describe('legenda espera folga na reprodução', () => {
  it('com streams demais abertos a extração espera; ao liberar, roda', async () => {
    vi.useFakeTimers();
    const releases = [noteStreamStart('cdn'), noteStreamStart('cdn')];
    expect(activeStreamCount('cdn')).toBe(2);
    let started = false;
    const p = runOnHost('cdn', 'interactive', async () => {
      started = true;
    }).promise;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(started).toBe(false);
    releases[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    await p;
    expect(started).toBe(true);
    releases[1]();
    expect(activeStreamCount('cdn')).toBe(0);
  });

  it('um stream só (o vídeo em reprodução) não segura a extração', async () => {
    vi.useFakeTimers();
    noteStreamStart('cdn');
    let started = false;
    const p = runOnHost('cdn', 'prefetch', async () => {
      started = true;
    }).promise;
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(started).toBe(true);
  });

  it('depois de 30 s sem folga roda mesmo assim (melhor lenta do que nunca)', async () => {
    vi.useFakeTimers();
    noteStreamStart('cdn');
    noteStreamStart('cdn');
    let started = false;
    const p = runOnHost('cdn', 'interactive', async () => {
      started = true;
    }).promise;
    await vi.advanceTimersByTimeAsync(31_000);
    await p;
    expect(started).toBe(true);
  });

  it('release é idempotente', () => {
    const release = noteStreamStart('cdn');
    release();
    release();
    expect(activeStreamCount('cdn')).toBe(0);
  });
});
