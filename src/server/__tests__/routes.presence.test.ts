import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.TRUST_PROXY = '1';

const { getRedisStatusMock, catalogStatusMock } = vi.hoisted(() => ({
  getRedisStatusMock: vi.fn(),
  catalogStatusMock: vi.fn(),
}));

vi.mock('../media/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../media/redis')>();
  return { ...actual, getRedisStatus: getRedisStatusMock };
});

vi.mock('../catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../catalog')>();
  return { ...actual, catalogStatus: catalogStatusMock };
});

const { startApi } = await import('./helpers');
const { createApiRouter } = await import('../app');
const { roomManager } = await import('../roomServer');
const statusRoutes = await import('../routes/status');

function createMockResponse() {
  const headers = new Map<string, string>();
  let body = '';
  const res = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    end(chunk?: string | Uint8Array) {
      if (chunk !== undefined) body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      this.headersSent = true;
      this.writableEnded = true;
      return this;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    getStatus: () => res.statusCode,
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    getJson: () => JSON.parse(body),
  };
}

describe('handlePresence', () => {
  beforeEach(() => {
    getRedisStatusMock.mockReset();
    catalogStatusMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retorna 200, Cache-Control: no-store e { rooms: 0, people: 0 } sem salas ativas', () => {
    vi.spyOn(roomManager, 'getStats').mockReturnValue({ rooms: 0, people: 0 });
    const req = {} as IncomingMessage;
    const mock = createMockResponse();

    statusRoutes.handlePresence(req, mock.res);

    expect(mock.getStatus()).toBe(200);
    expect(mock.getHeader('cache-control')).toBe('no-store');
    expect(mock.getJson()).toEqual({ rooms: 0, people: 0 });
    expect(getRedisStatusMock).not.toHaveBeenCalled();
    expect(catalogStatusMock).not.toHaveBeenCalled();
  });

  it('retorna { rooms: 2, people: 5 } quando há salas e pessoas ativas, sem consultar Redis nem catálogo', () => {
    vi.spyOn(roomManager, 'getStats').mockReturnValue({ rooms: 2, people: 5 });
    const req = {} as IncomingMessage;
    const mock = createMockResponse();

    statusRoutes.handlePresence(req, mock.res);

    expect(mock.getStatus()).toBe(200);
    expect(mock.getHeader('cache-control')).toBe('no-store');
    expect(mock.getJson()).toEqual({ rooms: 2, people: 5 });
    expect(getRedisStatusMock).not.toHaveBeenCalled();
    expect(catalogStatusMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/presence (router)', () => {
  let api: Awaited<ReturnType<typeof startApi>>;

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api = await startApi(createApiRouter);
  });

  afterAll(async () => {
    await api?.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    getRedisStatusMock.mockReset();
    catalogStatusMock.mockReset();
  });

  it('responde 200 com Cache-Control: no-store e estatísticas em memória sem exigir token', async () => {
    const spy = vi.spyOn(roomManager, 'getStats').mockReturnValue({ rooms: 2, people: 5 });
    try {
      const res = await fetch(`${api.base}/api/presence`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ rooms: 2, people: 5 });
      expect(getRedisStatusMock).not.toHaveBeenCalled();
      expect(catalogStatusMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('aplica rate limit por IP via apiGate e devolve 429 com Retry-After após 60 requisições', async () => {
    const spy = vi.spyOn(roomManager, 'getStats').mockReturnValue({ rooms: 1, people: 2 });
    const headers = { 'x-forwarded-for': '198.51.100.77' };
    try {
      for (let i = 0; i < 60; i++) {
        const ok = await fetch(`${api.base}/api/presence`, { headers });
        expect(ok.status).toBe(200);
      }

      const limited = await fetch(`${api.base}/api/presence`, { headers });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await limited.json()).toMatchObject({ code: 'rate_limited' });

      const otherIp = await fetch(`${api.base}/api/presence`, {
        headers: { 'x-forwarded-for': '198.51.100.78' },
      });
      expect(otherIp.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});
