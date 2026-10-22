import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AddonError,
  MAX_ADDONS,
  addAddon,
  addonSupports,
  loadAddons,
  normalizeAddonUrl,
  parseManifest,
  removeAddon,
  refreshAddon,
  resetAddonsMemory,
  streamTypeFor,
  type VideoAddon,
} from './addons';

const URL1 = 'https://addon.test/x/manifest.json';

function installStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

function fakeFetch(json: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 404, json: async () => json })) as unknown as typeof fetch;
}

const manifest = { name: 'Addon', types: ['movie', 'series'], idPrefixes: ['tt'], resources: ['stream'] };

beforeEach(() => {
  resetAddonsMemory();
  installStorage();
});

describe('normalizeAddonUrl', () => {
  it('converte stremio:// e apara espaços', () => {
    expect(normalizeAddonUrl('  stremio://addon.test/x/manifest.json ')).toBe(URL1);
  });
  it('recusa o que não serve', () => {
    expect(normalizeAddonUrl('http://addon.test/x/manifest.json')).toBeNull();
    expect(normalizeAddonUrl('')).toBeNull();
    expect(normalizeAddonUrl('https://addon.test/x')).toBeNull();
    expect(normalizeAddonUrl('javascript:alert(1)')).toBeNull();
  });
  it('aceita http só em localhost', () => {
    expect(normalizeAddonUrl('http://127.0.0.1:3102/manifest.json')).toBe('http://127.0.0.1:3102/manifest.json');
  });
});

describe('parseManifest', () => {
  it('recurso curto usa types/idPrefixes do manifesto', () => {
    const a = parseManifest(URL1, manifest);
    expect(a.name).toBe('Addon');
    expect(a.base).toBe('https://addon.test/x');
    expect(a.stream).toEqual({ types: ['movie', 'series'], idPrefixes: ['tt'] });
    expect(a.id).toMatch(/^[0-9a-f]{8}$/);
  });
  it('recurso longo usa os próprios', () => {
    const a = parseManifest(URL1, {
      ...manifest,
      resources: [{ name: 'stream', types: ['movie'], idPrefixes: ['tt'] }],
      idPrefixes: ['mal:'],
    });
    expect(a.stream).toEqual({ types: ['movie'], idPrefixes: ['tt'] });
  });
  it('sem stream lança no_stream', () => {
    expect(() => parseManifest(URL1, { name: 'A', resources: ['catalog'] })).toThrow(AddonError);
    try {
      parseManifest(URL1, { name: 'A', resources: ['catalog'] });
    } catch (e) {
      expect((e as AddonError).code).toBe('no_stream');
    }
  });
});

describe('addonSupports', () => {
  const mk = (types: string[] | null, idPrefixes: string[] | null): VideoAddon => ({
    id: 'x', name: 'A', manifestUrl: URL1, base: 'https://addon.test/x', stream: { types, idPrefixes },
  });
  it('confere o prefixo do id', () => {
    const a = mk(['series'], ['tt']);
    expect(addonSupports(a, 'series', 'tt2359704:0:1')).toBe(true);
    expect(addonSupports(a, 'series', 'mal:1')).toBe(false);
  });
  it('sem idPrefixes aceita tudo', () => {
    expect(addonSupports(mk(['movie'], null), 'movie', 'qualquer')).toBe(true);
  });
  it('tipo não declarado não serve', () => {
    expect(addonSupports(mk(['movie'], null), 'series', 'tt1')).toBe(false);
    expect(addonSupports(mk(null, null), 'movie', 'tt1')).toBe(false);
  });
  it('anime usa series se declarado, senão anime', () => {
    expect(streamTypeFor(mk(['anime'], null), 'anime')).toBe('anime');
    expect(streamTypeFor(mk(['series', 'anime'], null), 'anime')).toBe('series');
    expect(streamTypeFor(mk(['movie'], null), 'anime')).toBeNull();
  });
});

describe('addAddon', () => {
  it('grava e devolve', async () => {
    const a = await addAddon(URL1, fakeFetch(manifest));
    expect(a.manifestUrl).toBe(URL1);
    expect(loadAddons()).toHaveLength(1);
  });
  it('manifesto 404 vira unreachable', async () => {
    await expect(addAddon(URL1, fakeFetch({}, false))).rejects.toMatchObject({ code: 'unreachable' });
  });
  it('rede fora vira unreachable sem expor a URL', async () => {
    const f = (async () => {
      throw new Error(`falhou ${URL1}`);
    }) as unknown as typeof fetch;
    const err = (await addAddon(URL1, f).catch((e) => e)) as AddonError;
    expect(err.code).toBe('unreachable');
    expect(err.message).not.toContain('addon.test');
  });
  it('o 11º vira limit', async () => {
    for (let i = 0; i < MAX_ADDONS; i++) await addAddon(`https://addon.test/${i}/manifest.json`, fakeFetch(manifest));
    await expect(addAddon(URL1, fakeFetch(manifest))).rejects.toMatchObject({ code: 'limit' });
  });
  it('mesma URL vira duplicate', async () => {
    await addAddon(URL1, fakeFetch(manifest));
    await expect(addAddon(URL1, fakeFetch(manifest))).rejects.toMatchObject({ code: 'duplicate' });
  });
  it('URL inválida vira invalid_url', async () => {
    await expect(addAddon('nada', fakeFetch(manifest))).rejects.toMatchObject({ code: 'invalid_url' });
  });
});

describe('robustez', () => {
  it('URL com query ou fragmento é inválida', async () => {
    expect(normalizeAddonUrl(`${URL1}?k=v`)).toBeNull();
    expect(normalizeAddonUrl(`${URL1}#x`)).toBeNull();
    expect(() => parseManifest(`${URL1}?k=v`, manifest)).toThrow(AddonError);
    await expect(addAddon(`${URL1}?k=v`, fakeFetch(manifest))).rejects.toMatchObject({ code: 'invalid_url' });
  });
  it('setItem lançando mantém a lista na memória', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('cheio'); } });
    const a = await addAddon(URL1, fakeFetch(manifest));
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('x'); } });
    expect(loadAddons().map((x) => x.id)).toEqual([a.id]);
  });
  it('dois adds simultâneos da mesma URL deixam um só', async () => {
    const r = await Promise.allSettled([addAddon(URL1, fakeFetch(manifest)), addAddon(URL1, fakeFetch(manifest))]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.find((x) => x.status === 'rejected')).toMatchObject({ reason: { code: 'duplicate' } });
    expect(loadAddons()).toHaveLength(1);
  });
  it('11 adds simultâneos terminam com no máximo 10', async () => {
    const r = await Promise.allSettled(
      Array.from({ length: MAX_ADDONS + 1 }, (_, i) => addAddon(`https://addon.test/${i}/manifest.json`, fakeFetch(manifest)))
    );
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(loadAddons()).toHaveLength(MAX_ADDONS);
  });
});

describe('loadAddons / removeAddon / refreshAddon', () => {
  it('getItem lançando devolve []', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('x'); } });
    expect(loadAddons()).toEqual([]);
  });
  it('JSON corrompido devolve []', () => {
    localStorage.setItem('lunio_addons', '{nao');
    expect(loadAddons()).toEqual([]);
  });
  it('removeAddon tira o addon', async () => {
    const a = await addAddon(URL1, fakeFetch(manifest));
    expect(removeAddon(a.id)).toEqual([]);
    expect(loadAddons()).toEqual([]);
  });
  it('refreshAddon relê o manifesto', async () => {
    const a = await addAddon(URL1, fakeFetch(manifest));
    const list = await refreshAddon(a.id, fakeFetch({ ...manifest, name: 'Novo' }));
    expect(list[0].name).toBe('Novo');
    expect(loadAddons()[0].name).toBe('Novo');
  });
});
