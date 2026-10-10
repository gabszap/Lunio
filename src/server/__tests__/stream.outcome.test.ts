import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Desfecho de um trecho de mídia.
 *
 * Este teste existe por causa de um erro real de leitura: o log marcava transferências
 * NORMALMENTE concluídas como `[abortado]`, porque o relatório era fechado no `end` do
 * upstream checando `res.writableFinished` — e no `end` o Node ainda pode estar drenando
 * o que já leu para o socket. O sintoma real em produção era um `bytes=0-` de 88s
 * aparecendo como "cancelado" sem que nada tivesse sido cancelado.
 *
 * Quatro desfechos precisam sair distintos:
 *   completo  — `finish`: o cliente recebeu tudo
 *   cancelado — `close` sem `finish`: o cliente foi embora antes
 *   erro      — upstream ou socket quebraram
 *   upstream  — o upstream terminou mas o cliente ainda não recebeu tudo (não é cancelamento)
 */
vi.hoisted(() => {
  process.env.ALLOW_PRIVATE_URLS = '1';
});

const { pipeMediaStreamDirect } = await import('../media/stream');

const CHUNK = Buffer.alloc(64 * 1024, 3);
const SIZE = CHUNK.length * 8;

let origin: http.Server;
let originBase = '';
/** Controla o comportamento do origin por teste. */
let mode: 'ok' | 'lento' | 'erro' = 'ok';

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    const range = req.headers.range || '';
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
    const slice = Buffer.concat(Array.from({ length: Math.ceil((end - start + 1) / CHUNK.length) }, () => CHUNK))
      .subarray(0, end - start + 1);

    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${SIZE}`,
      'Content-Length': String(slice.length),
    });

    if (mode === 'erro') {
      // Quebra DEPOIS dos cabeçalhos: é o caminho que exercita o 'erro' do corpo.
      // (Quebrar antes faria o request falhar, e aí nem existe trecho para reportar.)
      res.write(slice.subarray(0, 32 * 1024));
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    if (mode === 'lento') {
      // Envia a primeira parte e segura o resto: o cliente vai embora no meio.
      res.write(slice.subarray(0, 64 * 1024));
      return; // conexão fica aberta, sem 'end'
    }
    res.end(slice);
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  originBase = `http://127.0.0.1:${(origin.address() as any).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => origin.close(() => r()));
});

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = `${originBase}/video.mp4`;
    pipeMediaStreamDirect(url, url, req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** Roda uma requisição capturando a linha [MediaStream] correspondente. */
async function run(opts: { abortAfterBytes?: number } = {}) {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => lines.push(a.join(' ')));
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => lines.push(a.join(' ')));
  const ac = new AbortController();
  try {
    const r = await fetch(`${base}/video.mp4`, { headers: { Range: 'bytes=0-' }, signal: ac.signal });
    const rd = r.body!.getReader();
    let b = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      b += value.length;
      if (opts.abortAfterBytes && b >= opts.abortAfterBytes) {
        ac.abort(); // simula o cliente indo embora (seek/aba fechada)
        break;
      }
    }
  } catch {
    // abort/reset esperado
  }
  await new Promise((r) => setTimeout(r, 120));
  spy.mockRestore();
  warn.mockRestore();
  return lines.find((l) => l.includes('[MediaStream]')) || '';
}

/** Como o `run`, mas com teto de tempo (para quando o corpo trava sem 'end' nem erro). */
async function runBounded(timeoutMs: number) {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => lines.push(a.join(' ')));
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => lines.push(a.join(' ')));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/video.mp4`, { headers: { Range: 'bytes=0-' }, signal: ac.signal });
    const rd = r.body!.getReader();
    for (;;) {
      const { done } = await rd.read();
      if (done) break;
    }
  } catch {
    // esperado
  }
  clearTimeout(timer);
  await new Promise((r) => setTimeout(r, 150));
  spy.mockRestore();
  warn.mockRestore();
  return lines.find((l) => l.includes('[MediaStream]')) || '';
}

describe('desfecho de um trecho de mídia', () => {
  it('transferência normal completa NÃO é marcada como abortada', async () => {
    mode = 'ok';
    const line = await run();
    expect(line).toContain('desfecho=completo');
    expect(line).not.toContain('cancelado');
    // O upstream terminou E o cliente recebeu tudo: os dois tempos existem.
    expect(line).toMatch(/upstreamTotal=[\d.]+ms/);
  });

  it('cliente que desiste no meio é marcado como cancelado', async () => {
    mode = 'lento';
    const line = await run({ abortAfterBytes: 65536 });
    expect(line).toContain('desfecho=cancelado');
    // Cancelado é o desfecho; não é 'completo' mesmo que o upstream ainda nem tenha terminado.
    expect(line).not.toContain('desfecho=completo');
    // O upstream NÃO terminou: por isso upstreamTotal precisa ser 'n/a'.
    expect(line).toContain('upstreamTotal=n/a');
    expect(line).toMatch(/bytes=\d+/);
  });

  it('upstream quebrado é erro, não cancelamento do cliente', async () => {
    mode = 'erro';
    const line = await runBounded(3000);
    expect(line).toContain('desfecho=erro');
    expect(line).not.toContain('cancelado');
  }, 15_000);

  it('nunca marca como abortado apenas por writableFinished falso no end do upstream', async () => {
    mode = 'ok';
    const line = await run();
    // A regressão original: um `completo` acabava com `[abortado]` quando o socket ainda
    // drenava. Garante que isso não volta.
    const isComplete = line.includes('desfecho=completo');
    expect(isComplete && !line.includes('[abortado')).toBe(true);
  });
});