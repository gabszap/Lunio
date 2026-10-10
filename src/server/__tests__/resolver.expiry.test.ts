import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TTL, expiração e renovação de URL assinada.
 *
 * O caso que importa em produção: a entrada do cache guarda uma URL do CDN que carrega
 * token. Quando o token expira, o CDN responde 4xx. O proxy precisa (a) conseguir renovar
 * passando pela URL de ORIGEM quando houve redirect, e (b) não ficar servindo uma URL morta
 * quando a URL de origem JÁ É a URL assinada.
 */
vi.hoisted(() => {
  process.env.ALLOW_PRIVATE_URLS = '1';
});

const { invalidateResolvedUrl, resolveFinalCdnUrl, resolvedUrlCache } = await import('../media/resolver');
const { pipeMediaStreamDirect } = await import('../media/stream');

const TTL_MS = 5 * 60_000;

let servers: http.Server[] = [];

/** Sobe um origin em porta livre e devolve a base. */
async function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as any).port}`;
}

afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers = [];
});

beforeEach(() => {
  resolvedUrlCache.clear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Origin CDN: enquanto `signed` for verdadeiro responde 206; depois, 403 (token expirado). */
function cdnBehaviour(state: { signed: boolean; probes: string[]; ranges: string[] }) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const range = req.headers.range || '';
    if (range === 'bytes=0-0') {
      state.probes.push(range);
      if (!state.signed) {
        res.writeHead(403, { 'Content-Length': '0' });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes 0-0/${SIZE}`,
        'Content-Length': '1',
      });
      res.end(Buffer.from([0]));
      return;
    }
    state.ranges.push(range || 'none');
    if (!state.signed) {
      res.writeHead(403, { 'Content-Length': '0' });
      res.end();
      return;
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
    const slice = Buffer.alloc(end - start + 1, 1);
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${SIZE}`,
      'Content-Length': String(slice.length),
    });
    res.end(slice);
  };
}

const SIZE = 4 * 1024 * 1024;

describe('TTL do cache de URLs resolvidas', () => {
  it('reaproveita a entrada dentro do TTL e re-sonda quando o TTL passa', async () => {
    const state = { signed: true, probes: [] as string[], ranges: [] as string[] };
    const base = await listen(cdnBehaviour(state));
    const url = `${base}/video.mp4`;

    await resolveFinalCdnUrl(url);
    expect(state.probes).toHaveLength(1);

    // Dentro do TTL: nenhuma ida extra.
    vi.setSystemTime(Date.now() + TTL_MS - 5_000);
    await resolveFinalCdnUrl(url);
    await resolveFinalCdnUrl(url);
    expect(state.probes).toHaveLength(1);

    // Passou do TTL: re-sonda (é o que renova a URL assinada do TorBox).
    vi.setSystemTime(Date.now() + 10_000);
    await resolveFinalCdnUrl(url);
    expect(state.probes).toHaveLength(2);

    // E a entrada renovada vale de novo por um TTL inteiro.
    vi.setSystemTime(Date.now() + TTL_MS - 5_000);
    await resolveFinalCdnUrl(url);
    expect(state.probes).toHaveLength(2);
  });

  it('uma URL que falha não entra no cache (nada de repetir um 4xx por TTL inteiro)', async () => {
    const state = { signed: false, probes: [] as string[], ranges: [] as string[] };
    const base = await listen(cdnBehaviour(state));
    const url = `${base}/video.mp4`;

    await resolveFinalCdnUrl(url);
    expect(state.probes).toHaveLength(1);
    expect(resolvedUrlCache.has(url)).toBe(false);

    await resolveFinalCdnUrl(url);
    expect(state.probes).toHaveLength(2);
  });
});

describe('URL assinada expirada', () => {
  it('origem que redireciona para o CDN: renova voltando pela URL de origem', async () => {
    const state = { signed: true, probes: [] as string[], ranges: [] as string[] };
    const cdnBase = await listen(cdnBehaviour(state));
    // A URL "de origem" (Torrentio/debrid) responde 302 para a URL assinada do CDN.
    const originBase = await listen((req, res) => {
      res.writeHead(302, { Location: `${cdnBase}/signed/video.mp4` });
      res.end();
    });

    const sourceUrl = `${originBase}/resolve?url=qualquer`;
    const resolved = await resolveFinalCdnUrl(sourceUrl);
    expect(resolved).toBe(`${cdnBase}/signed/video.mp4`);
    expect(resolvedUrlCache.get(sourceUrl)).toBe(resolved);

    // O token do CDN expira. O proxy tem que trocar a URL guardada por uma nova.
    state.signed = false;
    invalidateResolvedUrl(sourceUrl);

    // Re-resolve pela origem: o CDN ainda está expirado, então o status 403 sobe, mas o
    // importante é que ele voltou a consultar a ORIGEM (sondagem nova), não a usar a morta.
    await resolveFinalCdnUrl(sourceUrl);
    expect(state.probes.length).toBeGreaterThanOrEqual(1);

    // CDN de volta: a próxima resolução precisa de uma sondagem nova e volta a funcionar.
    state.signed = true;
    const again = await resolveFinalCdnUrl(sourceUrl);
    expect(again).toBe(`${cdnBase}/signed/video.mp4`);
  });

  it('origem que JÁ É a URL assinada: não há para onde renovar, o cache é descartado', async () => {
    const state = { signed: true, probes: [] as string[], ranges: [] as string[] };
    const base = await listen(cdnBehaviour(state));
    // Sem redirect: a URL que o player usa é a própria URL assinada do CDN.
    const url = `${base}/signed/video.mp4`;

    // Primeiro o CDN funciona: aí a decisão url→url entra no cache (é ela que evita a
    // sondagem a cada Range). Precisa estar populada para o teste ter o que invalidar.
    const resolved = await resolveFinalCdnUrl(url);
    expect(resolved).toBe(url);
    expect(resolvedUrlCache.has(url)).toBe(true);

    // Agora o token expira e o CDN passa a responder 403.
    state.signed = false;

    const proxy = await listen((req, res) => {
      pipeMediaStreamDirect(url, url, req, res);
    });
    const res = await fetch(`${proxy}/video.mp4`);
    expect(res.status).toBe(403);

    // A entrada morta não pode continuar servindo: tem que ter saído do cache, senão todo
    // playback levaria 403 até o TTL de 5 min expirar, sem chance de se recuperar.
    expect(resolvedUrlCache.has(url)).toBe(false);
  });
});

describe('métricas do stream', () => {
  it('mede cabeçalhos e primeiro byte do corpo separadamente, sem URL no log', async () => {
    const state = { signed: true, probes: [] as string[], ranges: [] as string[] };
    const base = await listen(cdnBehaviour(state));
    const url = `${base}/video.mp4`;
    const proxy = await listen((req, res) => pipeMediaStreamDirect(url, url, req, res));

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    try {
      const res = await fetch(`${proxy}/video.mp4`, { headers: { Range: 'bytes=0-1048575' } });
      await res.arrayBuffer();
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      spy.mockRestore();
    }

    const line = lines.find((l) => l.includes('[MediaStream]'));
    expect(line).toBeDefined();
    // Os dois tempos existem e são distintos — é a distinção que o TTFB único não fazia.
    expect(line).toMatch(/connectToHeaders=[\d.]+ms/);
    expect(line).toMatch(/headersToFirstByte=[\d.]+ms/);
    expect(line).toMatch(/hop=0/);
    // Nada de URL, token ou query string no log.
    expect(line).not.toContain('video.mp4');
    expect(line).not.toContain('?');
  });
});
