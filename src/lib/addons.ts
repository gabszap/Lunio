/**
 * Addons de vídeo (Stremio) da pessoa. Ficam só no localStorage: a URL do manifesto pode ter
 * configuração/credenciais e o servidor nunca a vê. Nenhum erro daqui inclui a URL.
 */

export interface VideoAddon {
  id: string;
  name: string;
  manifestUrl: string;
  base: string;
  // types: null = o recurso não suporta nenhum tipo
  stream: { types: string[] | null; idPrefixes: string[] | null };
}

export type AddonErrorCode = 'invalid_url' | 'unreachable' | 'no_stream' | 'limit' | 'duplicate';

export class AddonError extends Error {
  code: AddonErrorCode;
  constructor(code: AddonErrorCode) {
    super(code);
    this.name = 'AddonError';
    this.code = code;
  }
}

export const MAX_ADDONS = 10;
const ADDONS_KEY = 'lunio_addons';
const SUFFIX = '/manifest.json';

export function normalizeAddonUrl(input: string): string | null {
  let s = input.trim();
  if (s.toLowerCase().startsWith('stremio://')) s = `https://${s.slice('stremio://'.length)}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (!u.pathname.endsWith(SUFFIX)) return null;
  // URL de instalação do Stremio não usa query nem fragmento; aceitar quebraria o `base`
  if (u.search || u.hash) return null;
  return u.href;
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;

export function parseManifest(manifestUrl: string, json: unknown): VideoAddon {
  const m = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  const resources = Array.isArray(m.resources) ? m.resources : [];
  const res = resources.find((r) => r === 'stream' || (r && typeof r === 'object' && (r as { name?: unknown }).name === 'stream'));
  if (!name || res === undefined) throw new AddonError('no_stream');
  let base: string;
  try {
    const u = new URL(manifestUrl);
    if (u.search || u.hash || !u.pathname.endsWith(SUFFIX)) throw new Error('url');
    base = u.origin + u.pathname.slice(0, -SUFFIX.length);
  } catch {
    throw new AddonError('invalid_url');
  }
  // Recurso longo traz os próprios types/idPrefixes (regra do stremio-core)
  const src = typeof res === 'object' ? (res as Record<string, unknown>) : m;
  return {
    id: fnv1a(manifestUrl),
    name,
    manifestUrl,
    base,
    stream: { types: strings(src.types), idPrefixes: strings(src.idPrefixes) },
  };
}

export function streamTypeFor(addon: VideoAddon, type: 'movie' | 'series' | 'anime'): string | null {
  const types = addon.stream.types;
  if (!types) return null;
  if (type === 'anime') return types.includes('series') ? 'series' : types.includes('anime') ? 'anime' : null;
  return types.includes(type) ? type : null;
}

export function addonSupports(addon: VideoAddon, type: 'movie' | 'series' | 'anime', id: string): boolean {
  if (streamTypeFor(addon, type) === null) return false;
  const p = addon.stream.idPrefixes;
  return !p || p.some((x) => id.startsWith(x));
}

export function addonHost(addon: VideoAddon): string {
  try {
    return new URL(addon.manifestUrl).host;
  } catch {
    return '';
  }
}

// Fonte da verdade na sessão; o localStorage é persistência de melhor esforço
let memory: VideoAddon[] = [];
// Última gravação falhou: o armazenado está defasado e não pode sobrescrever a memória
let writeFailed = false;

export function resetAddonsMemory() {
  memory = [];
  writeFailed = false;
}

export function loadAddons(): VideoAddon[] {
  if (!writeFailed) {
    try {
      const saved = localStorage.getItem(ADDONS_KEY);
      const list = saved ? JSON.parse(saved) : [];
      memory = Array.isArray(list) ? list : [];
    } catch {
      // armazenamento indisponível: vale a memória
    }
  }
  return [...memory];
}

function saveAddons(list: VideoAddon[]) {
  memory = list;
  try {
    localStorage.setItem(ADDONS_KEY, JSON.stringify(list));
    writeFailed = false;
  } catch {
    writeFailed = true;
  }
}

async function fetchManifest(manifestUrl: string, fetchImpl: typeof fetch): Promise<VideoAddon> {
  let json: unknown;
  try {
    const r = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('http');
    json = await r.json();
  } catch {
    throw new AddonError('unreachable');
  }
  return parseManifest(manifestUrl, json);
}

export async function addAddon(input: string, fetchImpl: typeof fetch = fetch): Promise<VideoAddon> {
  const url = normalizeAddonUrl(input);
  if (!url) throw new AddonError('invalid_url');
  const list = loadAddons();
  if (list.length >= MAX_ADDONS) throw new AddonError('limit');
  if (list.some((a) => a.manifestUrl === url)) throw new AddonError('duplicate');
  const addon = await fetchManifest(url, fetchImpl);
  // Outro add pode ter terminado durante a espera
  const current = loadAddons();
  if (current.length >= MAX_ADDONS) throw new AddonError('limit');
  if (current.some((a) => a.manifestUrl === url)) throw new AddonError('duplicate');
  saveAddons([...current, addon]);
  return addon;
}

export function removeAddon(id: string): VideoAddon[] {
  const list = loadAddons().filter((a) => a.id !== id);
  saveAddons(list);
  return list;
}

export async function refreshAddon(id: string, fetchImpl: typeof fetch = fetch): Promise<VideoAddon[]> {
  const current = loadAddons().find((a) => a.id === id);
  if (!current) return loadAddons();
  const fresh = await fetchManifest(current.manifestUrl, fetchImpl);
  const list = loadAddons().map((a) => (a.id === id ? fresh : a));
  saveAddons(list);
  return list;
}
