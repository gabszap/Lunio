import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regressão do buffering: o player abre várias requisições de Range por vídeo. Cada uma
 * não pode custar uma ida extra ao CDN (a sondagem `bytes=0-0` do resolver) — era exatamente
 * isso que somava um round-trip por Range e fazia o buffer do player encher devagar.
 *
 * Aqui o proxy PRECISA alcançar 127.0.0.1 (origin de teste), então a rede privada é liberada.
 * A cobertura de bloqueio de rede interna continua em routes.security.test.ts.
 */
vi.hoisted(() => {
  process.env.ALLOW_PRIVATE_URLS = '1';
});

// Import dinâmico: `config` é um retrato do ambiente no momento do import, então a variável
// acima precisa estar posta antes de security/resolver entrarem no grafo.
const { invalidateResolvedUrl, resolveFinalCdnUrl, resolvedUrlCache } = await import('../media/resolver');
const { pipeMediaStreamDirect } = await import('../media/stream');

const CHUNK = Buffer.alloc(1024 * 1024, 7);
const SIZE = CHUNK.length * 4;

let originBase = '';
let originRequests: string[] = [];
let origin: http.Server;
let server: http.Server;
let base = '';

beforeAll(async () => {
  // Origin que responde 206 a Range e anota cada Range recebido (como uma CDN de verdade).
  originRequests = [];
  origin = http.createServer((req, res) => {
    const range = req.headers.range;
    originRequests.push(range || 'none');
    if (!range) {
      // Sem Range o player abre um stream aberto: corpo inteiro, tamanho honesto.
      const body = Buffer.concat([CHUNK, CHUNK, CHUNK, CHUNK]);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(body.length),
      });
      res.end(body);
      return;
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range)!;
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
    const full = Buffer.concat([CHUNK, CHUNK, CHUNK, CHUNK]);
    const slice = full.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${SIZE}`,
      'Content-Length': String(slice.length),
    });
    res.end(slice);
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  originBase = `http://127.0.0.1:${(origin.address() as any).port}`;

  // Mesmo caminho de produção: resolve (sondagem + cache) e então transmite.
  server = http.createServer(async (req, res) => {
    const target = `${originBase}/video.mp4`;
    try {
      const actual = await resolveFinalCdnUrl(target);
      pipeMediaStreamDirect(actual, target, req, res);
    } catch (err: any) {
      res.statusCode = 500;
      res.end(String(err?.message || 'erro'));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => origin.close(() => r()));
});

beforeEach(() => {
  resolvedUrlCache.clear();
  originRequests = [];
  invalidateResolvedUrl(`${originBase}/video.mp4`);
});

const probes = () => originRequests.filter((r) => r === 'bytes=0-0').length;
const media = () => originRequests.filter((r) => r !== 'bytes=0-0');

describe('resolver: sondagem ao CDN não se repete a cada Range', () => {
  it('guarda url→mesma-url mesmo sem redirect, evitando nova sondagem', async () => {
    const url = `${originBase}/video.mp4`;
    const first = await resolveFinalCdnUrl(url);
    expect(first).toBe(url);
    // A decisão está no cache: um Range seguinte não deve sondar de novo.
    expect(resolvedUrlCache.has(url)).toBe(true);
    expect(probes()).toBe(1);

    await resolveFinalCdnUrl(url);
    await resolveFinalCdnUrl(url);
    expect(probes()).toBe(1);
  });

  it('requisições de Range repetidas custam UMA ida extra ao origin, não uma por Range', async () => {
    const ranges = ['bytes=0-1048575', 'bytes=2097152-3145727', 'bytes=0-1048575'];
    for (const r of ranges) {
      const res = await fetch(`${base}/video.mp4`, { headers: { Range: r } });
      expect(res.status).toBe(206);
      await res.arrayBuffer();
    }
    // 3 pedidos de mídia + 1 única sondagem. Antes do fix: 3+ sondagens.
    expect(probes()).toBe(1);
    expect(media()).toHaveLength(3);
  });

  it('cold seek devolve 206 com o Content-Range pedido', async () => {
    const res = await fetch(`${base}/video.mp4`, { headers: { Range: 'bytes=2097152-3145727' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 2097152-3145727/${SIZE}`);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(1048576);
  });

  it('pedido sem Range não vira 206 e não mente sobre o tamanho', async () => {
    const res = await fetch(`${base}/video.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-range')).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(SIZE);
  });

  it('Ranges concorrentes do mesmo vídeo compartilham uma única sondagem', async () => {
    const ranges = ['bytes=0-1048575', 'bytes=1048576-2097151', 'bytes=2097152-3145727', 'bytes=3145728-4194303'];
    await Promise.all(
      ranges.map(async (r) => {
        const res = await fetch(`${base}/video.mp4`, { headers: { Range: r } });
        expect(res.status).toBe(206);
        await res.arrayBuffer();
      })
    );
    // Single-flight: as 4 janelas em paralelo provocam UMA sondagem, não 4.
    expect(probes()).toBe(1);
    expect(media()).toHaveLength(4);
  });
});