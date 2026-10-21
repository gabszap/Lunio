import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SESSION_SECRET = 'segredo-de-teste';

// Redis falso em memória (só o que o catálogo usa: get e set): prova que o cache sobrevive a um restart sem Redis de verdade
const fakeRedis = vi.hoisted(() => ({ data: new Map<string, string>() }));
vi.mock('../media/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../media/redis')>();
  return {
    ...actual,
    withRedis: async (_fallback: unknown, fn: (r: unknown) => Promise<unknown>) =>
      fn({
        get: async (k: string) => fakeRedis.data.get(k) ?? null,
        set: async (k: string, v: string) => {
          fakeRedis.data.set(k, v);
          return 'OK';
        },
      }),
  };
});

const { startApi } = await import('./helpers');
const { createApiRouter } = await import('../app');
const { config } = await import('../config');
const { DEFAULT_CATALOG_URL, normalizeCatalogBase, resetCatalogCache, summarizeManifest } = await import('../catalog');

/** Manifesto no formato do AIOMetadata/Stremio: fileiras, catálogos de busca (search obrigatório) e uma fileira que exige parâmetro. */
const MANIFEST = {
  id: 'aiometadata',
  name: 'AIOMetadata',
  catalogs: [
    { type: 'movie', id: 'tmdb.popular', name: 'Filmes populares', extra: [{ name: 'genre', options: ['Ação', 'Drama'] }, { name: 'skip' }] },
    { type: 'series', id: 'tmdb.trending', name: 'Séries em alta', extra: [{ name: 'skip' }] },
    { type: 'anime', id: 'mal.airing', name: 'Animes no ar', extra: [] },
    { type: 'movie', id: 'tmdb.search', name: 'Busca de filmes', extra: [{ name: 'search', isRequired: true }] },
    { type: 'series', id: 'tvdb.search', name: 'Busca de séries', extra: [{ name: 'search', isRequired: true }] },
    { type: 'movie', id: 'so-com-genero', name: 'Exige gênero', extra: [{ name: 'genre', isRequired: true, options: ['Ação', 'Drama'] }] },
    // tipos com ponto e uma fileira que exige gênero mas só tem uma opção
    { type: 'anime.series', id: 'search.anime_series', name: 'Anime Series Search', extra: [{ name: 'search', isRequired: true }] },
    { type: 'anime', id: 'mal.top_series', name: 'MAL Melhores Séries', extra: [{ name: 'genre', isRequired: true, options: ['Top'] }] },
  ],
};

let upstream: http.Server;
let base: string;
let hits: Record<string, number>;
let failing: boolean;
let jikanDown: boolean;
let errorItem: boolean; // a fonte responde 200 com um item de erro no lugar da lista
let emptyList: boolean;
let concurrent = 0;
let maxConcurrent = 0;

function respond(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  upstream = http.createServer((req, res) => {
    const path = decodeURIComponent(req.url || '');
    hits[path] = (hits[path] || 0) + 1;
    // API do MyAnimeList (Jikan ou compatível): GET /anime/<id> com data.score
    if (path.startsWith('/jikan/anime/')) return jikanDown ? respond(res, { error: { code: 'RATE_LIMITED' } }, 429) : respond(res, { data: { score: 8.25, scoredBy: 1607019, rank: 400 } });
    if (failing) return respond(res, { erro: 'fora' }, 503);
    // O caminho da fonte tem o UUID e a configuração da pessoa
    if (!path.startsWith('/stremio/UUID-SECRETO/CONFIG-SECRETA')) return respond(res, {}, 404);
    const rest = path.slice('/stremio/UUID-SECRETO/CONFIG-SECRETA'.length);
    if (rest === '/manifest.json') return respond(res, MANIFEST);
    if (errorItem && rest.startsWith('/catalog/anime/mal.airing')) return respond(res, { metas: [{ id: 'erro', type: 'anime', name: '[❌] AIOMetadata' }] });
    if (emptyList && rest.startsWith('/catalog/anime/mal.airing')) return respond(res, { metas: [] });
    if (rest.startsWith('/catalog/series/lenta-')) {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return void setTimeout(() => {
        concurrent--;
        respond(res, { metas: [{ id: rest, type: 'series', name: 'Lenta' }] });
      }, 60);
    }
    if (rest.startsWith('/catalog/movie/tmdb.search/search=')) {
      return respond(res, { metas: [
        { id: 'tmdb:1', imdb_id: 'tt0000001', type: 'movie', name: 'Link Click', poster: 'https://image.tmdb.org/a.jpg', releaseInfo: '2021' },
        { id: 'tmdb:2', type: 'movie', name: 'Outro Filme', poster: 'javascript:alert(1)', year: '2019' },
      ] });
    }
    if (rest.startsWith('/catalog/anime.series/search.anime_series/search=')) {
      return respond(res, { metas: [{ id: 'mal:31240', imdb_id: 'tt5607616', type: 'series', name: 'Re:ZERO (anime)', releaseInfo: '2016', poster: 'https://cdn.myanimelist.net/x.jpg' }] });
    }
    if (rest.startsWith('/catalog/anime/mal.top_series/genre=Top')) return respond(res, { metas: [{ id: 'mal:1', type: 'series', name: 'Top 1' }] });
    if (rest.startsWith('/catalog/series/tvdb.search/search=')) {
      return respond(res, { metas: [
        { id: 'tvdb:9', imdb_id: 'tt0000001', type: 'series', name: 'Link Click', releaseInfo: '2021–' }, // o mesmo título (mesmo IMDb)
        { id: 'tvdb:10', type: 'series', name: 'Só Série', releaseInfo: '2020' },
      ] });
    }
    if (rest.startsWith('/catalog/movie/tmdb.popular')) return respond(res, { metas: [{ id: 'tt1', type: 'movie', name: 'Popular 1' }, { id: 'tt2', name: '' }, { type: 'movie' }] });
    if (rest.startsWith('/catalog/anime/mal.airing')) return respond(res, { metas: [{ id: 'mal:5114', type: 'anime', name: 'Anime A', poster: 'https://cdn.myanimelist.net/x.jpg' }] });
    if (rest.startsWith('/meta/series/tt0000001')) return respond(res, { meta: { id: 'tt0000001', type: 'series', name: 'Link Click', _malId: '5114', videos: [] } });
    if (rest.startsWith('/meta/movie/tt0000009')) return respond(res, { meta: { id: 'tt0000009', type: 'movie', name: 'Sem MAL', videos: [] } });
    if (rest.startsWith('/meta/anime/')) {
      return respond(res, { meta: {
        id: 'mal:5114', type: 'anime', name: 'Anime A', description: 'Sinopse', genres: ['Ação'], runtime: '24 min', background: 'https://x/bg.jpg',
        videos: [
          { id: 'mal:5114:1:2', season: 1, episode: 2, name: 'Ep 2' },
          { id: 'mal:5114:0:1', season: 0, episode: 1, name: 'Especial 1' },
          { id: 'mal:5114:1:1', season: 1, episode: 1, title: 'Ep 1', thumbnail: 'https://x/t.jpg' },
          { id: 'sem-temporada', episode: 3, name: 'Sem temporada' },
        ],
      } });
    }
    respond(res, {}, 404);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => upstream.close(r));
});

describe('normalizeCatalogBase', () => {
  it('aceita a URL de instalação (https, stremio://, com /manifest.json) ou a base', () => {
    expect(normalizeCatalogBase('https://aio.exemplo.test/stremio/u/c/manifest.json')).toBe('https://aio.exemplo.test/stremio/u/c');
    expect(normalizeCatalogBase('stremio://aio.exemplo.test/stremio/u/c/manifest.json')).toBe('https://aio.exemplo.test/stremio/u/c');
    expect(normalizeCatalogBase('  https://aio.exemplo.test/stremio/u/c///  ')).toBe('https://aio.exemplo.test/stremio/u/c');
    expect(normalizeCatalogBase('http://127.0.0.1:3232/stremio/u/c/manifest.json?x=1#y')).toBe('http://127.0.0.1:3232/stremio/u/c');
  });

  it('vazio ou inválido vira "" (o padrão é o Cinemeta)', () => {
    for (const bad of ['', '   ', undefined, null, 'ftp://x.test/a', 'javascript:alert(1)', 'sem-esquema.test/a', 'https://']) {
      expect(normalizeCatalogBase(bad as any)).toBe('');
    }
  });
});

describe('summarizeManifest', () => {
  it('fileiras = catálogos sem parâmetro obrigatório; busca = quem declara search', () => {
    const s = summarizeManifest(MANIFEST);
    expect(s.name).toBe('AIOMetadata');
    // `so-com-genero` exige gênero com 2 opções: fora. `mal.top_series` exige gênero com uma só: entra com ele preenchido
    expect(s.rows.map((r) => r.id)).toEqual(['tmdb.popular', 'tmdb.trending', 'mal.airing', 'mal.top_series']);
    expect(s.rows[0].genres).toEqual(['Ação', 'Drama']);
    expect(s.rows[3]).toMatchObject({ type: 'anime', fixedGenre: 'Top' });
    expect(s.rows[0].fixedGenre).toBeUndefined();
    // inclui os catálogos de tipo com ponto (`anime.series`), que antes eram descartados
    expect(s.searchCatalogs).toEqual([
      { type: 'movie', id: 'tmdb.search', name: 'Busca de filmes' },
      { type: 'series', id: 'tvdb.search', name: 'Busca de séries' },
      { type: 'anime.series', id: 'search.anime_series', name: 'Anime Series Search' },
    ]);
  });

  it('entende o formato antigo (extraSupported/extraRequired) e o Cinemeta', () => {
    const s = summarizeManifest({ name: 'Cinemeta', catalogs: [{ type: 'movie', id: 'top', name: 'Popular', genres: ['Action'], extraSupported: ['search', 'genre', 'skip'] }, { type: 'movie', id: 'busca', extraRequired: ['search'], extraSupported: ['search'] }] });
    expect(s.rows.map((r) => r.id)).toEqual(['top']);
    expect(s.rows[0].genres).toEqual(['Action']);
    expect(s.searchCatalogs.map((c) => c.id)).toEqual(['top', 'busca']);
  });

  it('ignora entradas com tipo ou id estranhos', () => {
    expect(summarizeManifest({ catalogs: [{ type: '../x', id: 'a' }, { type: 'movie', id: 'a/b' }, null, { type: 'movie', id: 'ok' }] }).rows.map((r) => r.id)).toEqual(['ok']);
    expect(summarizeManifest({}).rows).toEqual([]);
  });
});

describe('/api/catalog/*', () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  let token: string;
  const get = (path: string) => fetch(`${api.base}/api/catalog/${path}`, { headers: { 'X-Lunio-Token': token } });
  const json = async (res: Response) => (await res.json()) as any;

  beforeAll(async () => {
    api = await startApi(createApiRouter);
    token = ((await (await fetch(`${api.base}/api/session`, { method: 'POST' })).json()) as { token: string }).token;
  });
  afterAll(async () => {
    await api?.close();
    config.catalogUrl = '';
    config.jikanUrl = '';
  });
  beforeEach(() => {
    hits = {};
    failing = false;
    jikanDown = false;
    errorItem = false;
    emptyList = false;
    concurrent = 0;
    maxConcurrent = 0;
    fakeRedis.data.clear();
    resetCatalogCache();
    config.catalogUrl = `${base}/stremio/UUID-SECRETO/CONFIG-SECRETA/manifest.json`;
    config.jikanUrl = `${base}/jikan`;
  });

  it('exige o token de sessão', async () => {
    expect((await fetch(`${api.base}/api/catalog/manifest`)).status).toBe(401);
  });

  it('manifest: devolve as fileiras e as buscas, sem a URL da fonte (UUID/configuração)', async () => {
    const res = await get('manifest');
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('UUID-SECRETO');
    expect(text).not.toContain('CONFIG-SECRETA');
    expect(text).not.toContain(base);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ name: 'AIOMetadata', isDefault: false, stale: false });
    expect(body.rows).toHaveLength(4);
    expect(body.searchCatalogs).toHaveLength(3);
  });

  it('row: monta o caminho com gênero e skip, e devolve itens limpos (sem nome, descarta; id preservado)', async () => {
    const body = await json(await get(`row?type=movie&id=tmdb.popular&genre=${encodeURIComponent('Ação')}&skip=20`));
    expect(Object.keys(hits)).toContain('/stremio/UUID-SECRETO/CONFIG-SECRETA/catalog/movie/tmdb.popular/genre=Ação&skip=20.json');
    expect(body.metas).toEqual([{ id: 'tt1', imdbId: 'tt1', type: 'movie', name: 'Popular 1' }]);
    const anime = await json(await get('row?type=anime&id=mal.airing'));
    expect(anime.metas[0]).toMatchObject({ id: 'mal:5114', type: 'anime', poster: 'https://cdn.myanimelist.net/x.jpg' });
    expect(anime.metas[0].imdbId).toBeUndefined();
  });

  it('row/meta: tipo, id, skip ou q inválidos são recusados (nada vira caminho na fonte)', async () => {
    for (const q of ['row?type=../x&id=a', 'row?type=movie&id=a/b', 'row?type=movie&id=a%20b', 'row?type=movie&id=a&skip=-1', 'row?type=movie&id=a&skip=abc', 'row?type=movie&id=a&skip=999999', 'meta?type=movie&id=../../x', 'meta?type=Mov&id=tt1', 'search?q=a', 'search']) {
      expect((await get(q)).status, q).toBe(400);
    }
    expect(Object.keys(hits)).toEqual([]);
    expect((await get('nada')).status).toBe(404);
  });

  it('search: um grupo por catálogo de busca (como o Stremio), na ordem do manifesto, com os de tipo com ponto, sem pôster que não é http(s)', async () => {
    const body = await json(await get('search?q=Link%20Click'));
    expect(body.groups.map((g: any) => [g.id, g.name, g.metas.map((m: any) => m.id)])).toEqual([
      ['tmdb.search', 'Busca de filmes', ['tmdb:1', 'tmdb:2']],
      ['tvdb.search', 'Busca de séries', ['tvdb:9', 'tvdb:10']],
      ['search.anime_series', 'Anime Series Search', ['mal:31240']],
    ]);
    // O mesmo título em dois catálogos aparece nos dois (cada fonte tem o seu id), e o item de anime é uma série com o IMDb junto
    expect(body.groups[0].metas[0]).toMatchObject({ imdbId: 'tt0000001', year: '2021' });
    expect(body.groups[1].metas[0]).toMatchObject({ imdbId: 'tt0000001' });
    expect(body.groups[2].metas[0]).toMatchObject({ id: 'mal:31240', type: 'series', imdbId: 'tt5607616' });
    expect(body.groups[0].metas[1].poster).toBeUndefined(); // javascript:… não passa
    expect(Object.keys(hits).filter((p) => p.includes('search='))).toHaveLength(3);
  });

  it('search: catálogo sem resultado não vira grupo vazio', async () => {
    const body = await json(await get('search?q=zzzz'));
    expect(body.groups.length).toBeGreaterThan(0);
    expect(body.groups.every((g: any) => g.metas.length > 0)).toBe(true);
  });

  it('row: fileira que exige um gênero de uma só opção é pedida com ele', async () => {
    const manifest = await json(await get('manifest'));
    const row = manifest.rows.find((r: any) => r.id === 'mal.top_series');
    expect(row).toMatchObject({ type: 'anime', fixedGenre: 'Top' });
    const body = await json(await get(`row?type=${row.type}&id=${row.id}&genre=${encodeURIComponent(row.fixedGenre)}`));
    expect(body.metas[0]).toMatchObject({ id: 'mal:1', type: 'series' });
  });

  it('o tipo com ponto (anime.series) é aceito nas rotas', async () => {
    expect((await get('row?type=anime.series&id=search.anime_series')).status).not.toBe(400);
    expect((await get('row?type=a..b/c&id=x')).status).toBe(400);
  });

  it('meta: id composto vai codificado, episódios ordenados com a temporada 0 e sem os que não têm temporada', async () => {
    const body = await json(await get(`meta?type=anime&id=${encodeURIComponent('mal:5114')}`));
    expect(Object.keys(hits)).toContain('/stremio/UUID-SECRETO/CONFIG-SECRETA/meta/anime/mal:5114.json');
    expect(body.meta).toMatchObject({ id: 'mal:5114', type: 'anime', name: 'Anime A', genres: ['Ação'], background: 'https://x/bg.jpg' });
    expect(body.meta.episodes.map((e: any) => `${e.season}x${e.episode}`)).toEqual(['0x1', '1x1', '1x2']);
    expect(body.meta.episodes[1]).toMatchObject({ title: 'Ep 1', thumbnail: 'https://x/t.jpg' });
  });

  it('cache: a segunda pergunta igual não vai à fonte', async () => {
    await get('row?type=anime&id=mal.airing');
    await get('row?type=anime&id=mal.airing');
    const path = '/stremio/UUID-SECRETO/CONFIG-SECRETA/catalog/anime/mal.airing.json';
    expect(hits[path]).toBe(1);
  });

  it('perguntas iguais ao mesmo tempo viram uma só ida à fonte', async () => {
    await Promise.all([get('row?type=anime&id=mal.airing'), get('row?type=anime&id=mal.airing'), get('row?type=anime&id=mal.airing')]);
    expect(hits['/stremio/UUID-SECRETO/CONFIG-SECRETA/catalog/anime/mal.airing.json']).toBe(1);
  });

  it('fonte fora do ar: serve a última resposta guardada (stale) e, sem nenhuma, 502', async () => {
    // guarda uma resposta e a faz envelhecer além da validade de 15 min
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect((await json(await get('row?type=anime&id=mal.airing'))).stale).toBe(false);
      vi.setSystemTime(Date.now() + 20 * 60_000);
      failing = true;
      const body = await json(await get('row?type=anime&id=mal.airing'));
      expect(body.stale).toBe(true);
      expect(body.metas[0].name).toBe('Anime A');
    } finally {
      vi.useRealTimers();
    }
    const nothing = await get('row?type=movie&id=tmdb.popular');
    expect(nothing.status).toBe(502);
    expect(await json(nothing)).toMatchObject({ code: 'catalog_unavailable' });
  });

  it('item de erro no lugar da lista (200 com "[❌] …") é falha: não vai para o cache e, com cache, serve o antigo', async () => {
    errorItem = true;
    const first = await get('row?type=anime&id=mal.airing');
    expect(first.status).toBe(502);
    expect(await json(first)).toMatchObject({ code: 'catalog_unavailable' });

    // a fonte se recupera: a resposta boa aparece na hora (o erro não ficou guardado)
    errorItem = false;
    expect((await json(await get('row?type=anime&id=mal.airing'))).metas[0].name).toBe('Anime A');

    // com uma resposta boa guardada, o erro seguinte serve a guardada (stale)
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 20 * 60_000);
      errorItem = true;
      const stale = await json(await get('row?type=anime&id=mal.airing'));
      expect(stale).toMatchObject({ stale: true });
      expect(stale.metas[0].name).toBe('Anime A');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lista vazia vale só 30 s (fonte fria): a seguinte pergunta, depois disso, volta à fonte', async () => {
    emptyList = true;
    const path = '/stremio/UUID-SECRETO/CONFIG-SECRETA/catalog/anime/mal.airing.json';
    expect((await json(await get('row?type=anime&id=mal.airing'))).metas).toEqual([]);
    await get('row?type=anime&id=mal.airing');
    expect(hits[path]).toBe(1); // dentro dos 30 s vem do cache

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 40_000);
      emptyList = false;
      expect((await json(await get('row?type=anime&id=mal.airing'))).metas[0].name).toBe('Anime A');
      expect(hits[path]).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no máximo 4 pedidos simultâneos à fonte (uma Home inteira não a atropela)', async () => {
    const calls = Array.from({ length: 12 }, (_, i) => get(`row?type=series&id=lenta-${i}`));
    const results = await Promise.all(calls);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(maxConcurrent).toBeLessThanOrEqual(4);
  });

  it('o cache sobrevive a um restart: com a memória vazia, o Redis responde sem ir à fonte, e a chave não tem a URL da fonte', async () => {
    const path = '/stremio/UUID-SECRETO/CONFIG-SECRETA/catalog/anime/mal.airing.json';
    await get('row?type=anime&id=mal.airing');
    await new Promise((r) => setTimeout(r, 20)); // a gravação no Redis não é esperada
    expect(hits[path]).toBe(1);
    for (const k of fakeRedis.data.keys()) {
      expect(k.startsWith('lunio:catalog:')).toBe(true);
      expect(k).not.toContain('SECRET');
    }

    resetCatalogCache(); // "restart": a memória some, o Redis fica
    const body = await json(await get('row?type=anime&id=mal.airing'));
    expect(body).toMatchObject({ stale: false });
    expect(body.metas[0].name).toBe('Anime A');
    expect(hits[path]).toBe(1);

    // e com a fonte fora do ar depois do restart ainda há o que mostrar
    resetCatalogCache();
    failing = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 20 * 60_000);
      expect((await json(await get('row?type=anime&id=mal.airing'))).stale).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('meta de anime traz a nota do MyAnimeList (API do MAL), votos e ranking junto com o id', async () => {
    const body = await json(await get(`meta?type=anime&id=${encodeURIComponent('mal:5114')}`));
    expect(body.meta).toMatchObject({ malId: '5114', malScore: 8.25, malScoredBy: 1607019, malRank: 400 });
    expect(hits['/jikan/anime/5114']).toBe(1);
  });

  it('item do IMDb com _malId no detalhe também recebe a nota (pelo _malId)', async () => {
    const body = await json(await get('meta?type=series&id=tt0000001'));
    expect(body.meta).toMatchObject({ id: 'tt0000001', malId: '5114', malScore: 8.25 });
  });

  it('API do MAL fora do ar (ou limitando): o detalhe vem do mesmo jeito, só sem a nota', async () => {
    jikanDown = true;
    const res = await get(`meta?type=anime&id=${encodeURIComponent('mal:5114')}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.meta).toMatchObject({ name: 'Anime A', malId: '5114' });
    expect(body.meta.malScore).toBeUndefined();
  });

  it('a nota fica guardada: abrir o mesmo anime de novo não volta à API do MAL; e quem não é do MAL nem pergunta', async () => {
    await get(`meta?type=anime&id=${encodeURIComponent('mal:5114')}`);
    resetCatalogCache(); // o detalhe em si não está guardado; a nota está (no Redis falso)
    await get(`meta?type=anime&id=${encodeURIComponent('mal:5114')}`);
    expect(hits['/jikan/anime/5114']).toBe(1);

    const hitsBefore = Object.keys(hits).filter((p) => p.startsWith('/jikan')).length;
    const plain = await json(await get('meta?type=movie&id=tt0000009'));
    expect(plain.meta.malId).toBeUndefined();
    expect(Object.keys(hits).filter((p) => p.startsWith('/jikan')).length).toBe(hitsBefore);
  });

  it('/api/status traz o estado do catálogo (ok, nome) e, fora do ar, ok false', async () => {
    const okStatus = await (await fetch(`${api.base}/api/status`)).json();
    expect(okStatus.catalog).toMatchObject({ ok: true, stale: false, name: 'AIOMetadata', isDefault: false });
    resetCatalogCache();
    fakeRedis.data.clear(); // sem nada guardado, nem no Redis
    failing = true;
    const down = await (await fetch(`${api.base}/api/status`)).json();
    expect(down.catalog).toMatchObject({ ok: false, stale: false });
  });

  it('sem CATALOG_URL a fonte é o Cinemeta (o padrão não muda)', () => {
    config.catalogUrl = '';
    expect(normalizeCatalogBase(config.catalogUrl) || DEFAULT_CATALOG_URL).toBe('https://v3-cinemeta.strem.io');
  });
});
