import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dirSize } from './helpers';

// A config lê o ambiente ao ser importada: precisa estar pronto antes dos imports dinâmicos abaixo.
// Cota de envio = o que já existe em .uploads + 150 KB; proxy SEM liberar rede privada (padrão de produção).
const UPLOADS = path.resolve(process.cwd(), '.uploads');
const env = vi.hoisted(() => ({ headroom: 150_000 }));
process.env.ALLOW_PRIVATE_URLS = '';
process.env.MAX_UPLOAD_DISK_GB = String((dirSize(UPLOADS) + env.headroom) / 1024 ** 3);
process.env.SESSION_SECRET = 'segredo-de-teste';

type Api = Awaited<ReturnType<typeof import('./helpers').startApi>>;
let api: Api;
let manager: typeof import('../roomServer').roomManager;
let helpers: typeof import('./helpers');
let soloToken: string;
let host: { token: string; socket: import('./helpers').FakeSocket };
let guest: { token: string };
const createdUploadDirs = new Set<string>();

const json = async (res: Response) => res.json() as Promise<any>;
const withToken = (token: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers as object), 'X-Lunio-Token': token } });

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  helpers = await import('./helpers');
  const { createApiRouter } = await import('../app');
  manager = (await import('../roomServer')).roomManager;
  api = await helpers.startApi(createApiRouter);
  soloToken = (await json(await fetch(`${api.base}/api/session`, { method: 'POST' }))).token;
  host = helpers.joinRoom(manager, 'SEGSALA', 'host1');
  guest = helpers.joinRoom(manager, 'SEGSALA', 'guest1');
});

afterAll(async () => {
  await api.close();
  for (const dir of createdUploadDirs) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('SSRF: o proxy recusa rede interna', () => {
  const blocked = [
    'http://127.0.0.1:3000/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://2130706433/', // 127.0.0.1 em decimal
    'http://10.0.0.5/video.mkv',
    'http://192.168.1.1/',
    'http://localhost/',
    'http://[::ffff:127.0.0.1]/',
    'file:///etc/passwd',
    'ftp://example.com/x.mkv',
  ];

  for (const route of ['proxy', 'resolve', 'tracks']) {
    it.each(blocked)(`/api/${route} recusa %s`, async (url) => {
      const res = await fetch(`${api.base}/api/${route}?url=${encodeURIComponent(url)}`, withToken(soloToken));
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({ code: 'url_blocked' });
    });
  }

  it('subtitle e font também recusam', async () => {
    const url = encodeURIComponent('http://10.0.0.5/video.mkv');
    const sub = await fetch(`${api.base}/api/subtitle?url=${url}&track=2`, withToken(soloToken));
    expect(sub.status).toBe(403);
    const font = await fetch(`${api.base}/api/font?url=${url}&track=4&name=a.ttf`, withToken(soloToken));
    expect(font.status).toBe(403);
  });

  it('o remux (áudio alternativo) também passa pelo filtro', async () => {
    const res = await fetch(`${api.base}/api/proxy?url=${encodeURIComponent('http://169.254.169.254/')}&audio=2`, withToken(soloToken));
    expect(res.status).toBe(403);
  });
});

describe('token de sessão', () => {
  it('rotas de mídia exigem token', async () => {
    for (const p of ['/api/proxy?url=https://example.com/x', '/api/tracks?url=https://example.com/x', '/api/uploads/aaaaaaaaaaaaaaaa/x.mp4']) {
      expect((await fetch(api.base + p)).status).toBe(401);
    }
  });

  it('token adulterado ou de outro segredo não vale', async () => {
    const res = await fetch(`${api.base}/api/tracks?url=http://10.0.0.1/`, withToken(`${soloToken}x`));
    expect(res.status).toBe(401);
  });

  it('?t= funciona como o cabeçalho (necessário para <video src>)', async () => {
    const res = await fetch(`${api.base}/api/proxy?url=${encodeURIComponent('http://127.0.0.1/')}&t=${encodeURIComponent(soloToken)}`);
    expect(res.status).toBe(403); // passou da autenticação e caiu no filtro de SSRF
  });

  it('token de quem foi banido deixa de valer', async () => {
    const victim = helpers.joinRoom(manager, 'SEGSALA', 'vitima');
    const before = await fetch(`${api.base}/api/proxy?url=${encodeURIComponent('http://127.0.0.1/')}`, withToken(victim.token));
    expect(before.status).toBe(403); // autenticado
    manager.handleClientMessage(helpers.asWs(host.socket), JSON.stringify({ type: 'room:ban', targetUserId: 'vitima' }));
    const after = await fetch(`${api.base}/api/proxy?url=${encodeURIComponent('http://127.0.0.1/')}`, withToken(victim.token));
    expect(after.status).toBe(401);
  });
});

describe('CORS e limites', () => {
  it('origem estranha é recusada e a resposta nunca usa "*"', async () => {
    const bad = await fetch(`${api.base}/api/room?id=ABCD`, { headers: { Origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
    const same = await fetch(`${api.base}/api/room?id=ABCD`, { headers: { Origin: api.base } });
    expect(same.status).toBe(200);
    expect(same.headers.get('access-control-allow-origin')).toBe(api.base);
    const pre = await fetch(`${api.base}/api/upload`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(403);
  });

  it('a Discord Activity é uma origem aceita', async () => {
    const { config } = await import('../config');
    const res = await fetch(`${api.base}/api/room?id=ABCD`, { headers: { Origin: `https://${config.discordClientId}.discordsays.com` } });
    expect(res.status).toBe(200);
  });

  it('rate limit por IP devolve 429 com Retry-After', async () => {
    let last: Response | null = null;
    for (let i = 0; i < 31; i++) last = await fetch(`${api.base}/api/status`);
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('erros não vazam stack nem caminho', async () => {
    const res = await fetch(`${api.base}/api/subtitle?url=https://example.com/x.mkv&track=../../etc`, withToken(soloToken));
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).not.toMatch(/node_modules|\bat \w+ \(|[A-Z]:\\|\/home\//);
    expect(JSON.parse(text)).toEqual({ error: expect.any(String), code: 'bad_request' });
  });
});

describe('envio de arquivos', () => {
  const upload = (token: string | null, name: string, size: number, extra: RequestInit = {}) =>
    fetch(`${api.base}/api/upload?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      ...extra,
      headers: { ...(token ? { 'X-Lunio-Token': token } : {}), ...((extra.headers as object) || {}) },
      body: new Uint8Array(size).fill(7),
    });
  const track = async (res: Response) => {
    const body = await json(res);
    if (body.id) createdUploadDirs.add(path.join(UPLOADS, body.id));
    return body;
  };

  it('sem token: 401. Token solo ou de espectador: 403 not_host', async () => {
    expect((await upload(null, 'a.mp4', 100)).status).toBe(401);
    const solo = await upload(soloToken, 'a.mp4', 100);
    expect(solo.status).toBe(403);
    expect(await json(solo)).toMatchObject({ code: 'not_host' });
    expect((await upload(guest.token, 'a.mp4', 100)).status).toBe(403);
  });

  it('o Host envia; o nome é sempre sanitizado', async () => {
    const res = await upload(host.token, '../../etc/passwd.mp4', 2000);
    expect(res.status).toBe(200);
    const body = await track(res);
    expect(body.name).toBe('passwd.mp4');
    expect(body.url).toBe(`/api/uploads/${body.id}/passwd.mp4`);

    const dots = await track(await upload(host.token, '..', 300));
    expect(dots.name).not.toMatch(/^\./);
    const win = await track(await upload(host.token, 'CON.mp4', 300));
    expect(win.name).not.toMatch(/^con\./i);
  });

  it('serve com Range (206), 416 fora do intervalo, 200 completo e HEAD', async () => {
    const body = await track(await upload(host.token, 'range.mp4', 1000));
    const url = `${api.base}${body.url}`;
    const full = await fetch(url, withToken(host.token));
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect((await full.arrayBuffer()).byteLength).toBe(1000);

    const part = await fetch(url, withToken(host.token, { headers: { Range: 'bytes=10-19' } }));
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect((await part.arrayBuffer()).byteLength).toBe(10);

    const suffix = await fetch(url, withToken(host.token, { headers: { Range: 'bytes=-5' } }));
    expect(suffix.headers.get('content-range')).toBe('bytes 995-999/1000');

    const outside = await fetch(url, withToken(host.token, { headers: { Range: 'bytes=5000-6000' } }));
    expect(outside.status).toBe(416);

    const head = await fetch(url, withToken(host.token, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('1000');
  });

  it('não serve arquivo fora da pasta do envio', async () => {
    const res = await fetch(`${api.base}/api/uploads/aaaaaaaaaaaaaaaa/..%2F..%2Fpackage.json`, withToken(soloToken));
    expect(res.status).toBe(404);
    const bad = await fetch(`${api.base}/api/uploads/..%2F..%2F/package.json`, withToken(soloToken));
    expect(bad.status).toBe(404);
  });

  it('1 envio por vez por sala', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // corpo em streaming que só termina quando liberamos: mantém o primeiro envio "em andamento"
    const slowBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(1000));
        await gate;
        controller.enqueue(new Uint8Array(1000));
        controller.close();
      },
    });
    const first = fetch(`${api.base}/api/upload?name=lento.mp4`, {
      method: 'POST',
      headers: { 'X-Lunio-Token': host.token, 'Content-Length': '2000' },
      body: slowBody,
      duplex: 'half',
    } as RequestInit);
    await new Promise((r) => setTimeout(r, 300));
    const second = await upload(host.token, 'segundo.mp4', 100);
    expect(second.status).toBe(409);
    expect(await json(second)).toMatchObject({ code: 'upload_in_progress' });
    release();
    const done = await first;
    expect(done.status).toBe(200);
    await track(done);
  });

  it('envio acima da cota de disco: 507', async () => {
    const res = await upload(host.token, 'enorme.mp4', env.headroom + 50_000);
    expect(res.status).toBe(507);
    expect(await json(res)).toMatchObject({ code: 'quota_exceeded' });
  });

  it('arquivo maior que o limite individual: 413', async () => {
    // MAX_UPLOAD_FILE_GB padrão = 50 GB; declara um Content-Length absurdo sem enviar o corpo
    const res = await fetch(`${api.base}/api/upload?name=x.mp4`, {
      method: 'POST',
      headers: { 'X-Lunio-Token': host.token, 'Content-Length': String(60 * 1024 ** 3) },
      body: new Uint8Array(0),
    }).catch((e) => e);
    // o servidor responde 413 antes de ler o corpo (ou fecha a conexão); nunca aceita
    if (res instanceof Response) expect(res.status).toBe(413);
  });
});
