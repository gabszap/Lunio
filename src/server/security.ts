import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { config } from './config';

/**
 * Proteção contra SSRF: o servidor busca URLs que o usuário informa (proxy, tracks, legendas…).
 * Só aceita http(s) e só conecta em endereços públicos — loopback, redes privadas, link-local e
 * metadados de nuvem (169.254.169.254) são recusados, inclusive depois de redirecionamentos.
 */

export class UrlBlockedError extends Error {
  readonly code = 'url_blocked';
  constructor(reason: string) {
    super(reason);
    this.name = 'UrlBlockedError';
  }
}

/** Erro de URL recusada (inclusive quando o Node o embrulha ao falhar a conexão). */
export function isBlockedError(err: unknown): boolean {
  return err instanceof UrlBlockedError || (err as { code?: string } | null)?.code === 'url_blocked';
}

const blocked = new net.BlockList();
const V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local + metadados de nuvem
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reservado + broadcast
];
for (const [addr, prefix] of V4) blocked.addSubnet(addr, prefix, 'ipv4');
const V6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // ULA
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];
for (const [addr, prefix] of V6) blocked.addSubnet(addr, prefix, 'ipv6');

/** `::ffff:127.0.0.1` / `::ffff:7f00:1` → IPv4 embutido, para checar contra as regras de IPv4. */
function unmapV4(address: string): string | null {
  const m = /^::ffff:(.+)$/i.exec(address);
  if (!m) return null;
  const tail = m[1];
  if (net.isIPv4(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(ip);
  if (!family) return false;
  if (family === 6) {
    const mapped = unmapV4(ip);
    if (mapped) return isPublicAddress(mapped);
    return !blocked.check(ip, 'ipv6');
  }
  return !blocked.check(ip, 'ipv4');
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

/** Valida esquema e, para IP literal, o endereço. Síncrono; o DNS é checado na conexão (`safeLookup`). */
export function checkUrlSyntax(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlBlockedError('URL inválida');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlBlockedError(`Esquema não permitido: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new UrlBlockedError('URL com credenciais não é aceita');
  }
  const host = hostOf(url);
  if (!host) throw new UrlBlockedError('URL sem host');
  if (config.allowPrivateUrls) return url;
  if (net.isIP(host) && !isPublicAddress(host)) {
    throw new UrlBlockedError('Endereço de rede interna');
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new UrlBlockedError('Host interno');
  }
  return url;
}

/** Valida a URL por completo: esquema + resolução de DNS. Use antes de entregar a URL ao FFmpeg/Python. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = checkUrlSyntax(raw);
  const host = hostOf(url);
  if (net.isIP(host) || config.allowPrivateUrls) return url;
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UrlBlockedError('Host não encontrado');
  }
  if (addrs.length === 0 || addrs.some((a) => !isPublicAddress(a.address))) {
    throw new UrlBlockedError('O host resolve para uma rede interna');
  }
  return url;
}

/**
 * `lookup` para os agentes http(s): valida o IP no momento exato da conexão, o que fecha a janela de
 * DNS rebinding (host que responde público na checagem e privado na conexão).
 */
export const safeLookup = ((hostname: string, options: any, callback: any) => {
  dns.lookup(hostname, options, (err: any, address: any, family: any) => {
    if (err) return callback(err, address, family);
    if (config.allowPrivateUrls) return callback(null, address, family);
    const list: Array<{ address: string }> = Array.isArray(address) ? address : [{ address }];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      return callback(new UrlBlockedError('O host resolve para uma rede interna'), address, family);
    }
    callback(null, address, family);
  });
}) as net.LookupFunction;

const agentOptions = {
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 100,
  maxFreeSockets: 30,
  timeout: 60000,
  lookup: safeLookup,
};
export const safeHttpsAgent = new https.Agent(agentOptions);
export const safeHttpAgent = new http.Agent(agentOptions);

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** URL final, depois dos redirecionamentos. */
  url: string;
  body: http.IncomingMessage;
}

/**
 * Requisição com redirecionamentos manuais: cada salto é revalidado, então um redirect 302 para
 * `http://169.254.169.254/` é recusado como a URL original seria.
 */
export async function safeRequest(
  rawUrl: string,
  opts: { method?: string; headers?: Record<string, string>; maxRedirects?: number; timeoutMs?: number } = {}
): Promise<SafeResponse> {
  let current = rawUrl;
  const maxRedirects = opts.maxRedirects ?? 5;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = checkUrlSyntax(current);
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const isHttps = url.protocol === 'https:';
      const req = (isHttps ? https : http).request(
        url,
        { method: opts.method || 'GET', headers: opts.headers, agent: isHttps ? safeHttpsAgent : safeHttpAgent },
        resolve
      );
      req.setTimeout(opts.timeoutMs ?? 20000, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
    const status = res.statusCode || 0;
    const location = res.headers.location;
    if (REDIRECT_CODES.has(status) && location) {
      res.resume();
      current = new URL(location, url).href;
      continue;
    }
    return { status, headers: res.headers, url: current, body: res };
  }
  throw new UrlBlockedError('Redirecionamentos demais');
}

/** Lê no máximo `limit` bytes do corpo como texto e descarta o resto. */
export async function readText(body: http.IncomingMessage, limit = 512 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) {
      body.destroy();
      break;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
