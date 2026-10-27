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
const { DEFAULT_CATALOG_URL, malRetry, normalizeCatalogBase, resetCatalogCache, summarizeManifest } = await import('../catalog');

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
let jikanFailures: number; // quantas respostas 429 antes de acertar
let jikanNoScore: boolean;
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
    if (path.startsWith('/jikan/anime/')) {
      if (jikanDown || jikanFailures-- > 0) return respond(res, { error: { code: 'RATE_LIMITED' } }, 429);
      return respond(res, { data: jikanNoScore ? { score: null } : { score: 8.25, scoredBy: 1607019, rank: 400 } });
    }
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
    // Busca por nome de um anime que só se conhece pelo IMDb: o item do MAL vem com o imdb_id junto
    if (rest.startsWith('/catalog/anime.series/search.anime_series/search=Anime IMDb')) {
      return respond(res, { metas: [{ id: 'mal:99', type: 'series', imdb_id: 'tt0000003', name: 'Outro' }, { id: 'mal:777', type: 'series', imdb_id: 'tt0000002', name: 'Anime IMDb' }, { id: 'mal:778', type: 'series', imdb_id: 'tt0000002', name: 'Anime IMDb 2' }] });
    }
    // Anime do IMDb com várias entradas no MAL (as de /meta/ ficam mais abaixo): a ordem do id não é a das temporadas
    // Só o nome sem o ano acha as entradas (o meta de um mal: chama a série de "Anime Longo (2012)")
    if (rest === '/catalog/anime.series/search.anime_series/search=Anime Longo.json') {
      const entry = (n: number, releaseInfo: string, imdb: string | null = 'tt0000005') => ({ id: `mal:${n}`, type: 'series', imdb_id: imdb, name: `Anime Longo ${n}`, releaseInfo });
      // 100 = T1 (2012), 200 = OVA do mesmo ano (id maior), 300/350 = T2 em duas partes (2014 e 2015), 400 = T3 (2016), 999 = outro IMDb
      return respond(res, { metas: [entry(400, '2016'), entry(350, '2015'), entry(300, '2014-2015'), entry(200, '2012'), entry(100, '2012-2013'), entry(999, '2012', 'tt0000999')] });
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
    if (rest.startsWith('/meta/series/tt0000002')) return respond(res, { meta: { id: 'tt0000002', imdb_id: 'tt0000002', type: 'series', name: 'Anime IMDb', _originalLanguage: 'ja', videos: [] } });
    // Anime do IMDb com várias entradas no MAL: a ordem do id não é a das temporadas (200 é uma OVA, 300 e 350 são partes da 2ª)
    if (rest.startsWith('/meta/series/tt0000005')) {
      const ep = (season: number, n: number, released: string) => ({ id: `tt0000005:${season}:${n}`, season, episode: n, released });
      return respond(res, { meta: {
        id: 'tt0000005', imdb_id: 'tt0000005', type: 'series', name: 'Anime Longo', _originalLanguage: 'ja', poster: 'https://image.tmdb.org/japones.jpg',
        app_extras: { seasonPosters: { '1': 'https://image.tmdb.org/s1-japones.jpg', '2': 'https://image.tmdb.org/s2-japones.jpg', '3': 'https://image.tmdb.org/s3-japones.jpg', '4': 'https://image.tmdb.org/s4-japones.jpg' } },
        videos: [ep(1, 1, '2012-10-06T11:00:00.000Z'), ep(1, 2, '2013-03-30T11:00:00.000Z'), ep(2, 1, '2014-04-05T11:00:00.000Z'), ep(2, 13, '2015-01-10T11:00:00.000Z'), ep(3, 1, '2016-04-01T11:00:00.000Z'), ep(0, 1, '2013-01-01T11:00:00.000Z')],
      } });
    }
    // Qualquer entrada do MAL devolve a série inteira, com a arte ocidental (TheTVDB): não diz qual entrada é qual temporada
    const malEntry = /^\/meta\/series\/mal(?:%3A|:)(100|200|300|350|400)/.exec(rest);
    if (malEntry) {
      return respond(res, { meta: { id: `mal:${malEntry[1]}`, imdb_id: 'tt0000005', type: 'series', name: 'Anime Longo (2012)', poster: 'https://thetvdb.test/serie.jpg', app_extras: { seasonPosters: { '1': 'https://thetvdb.test/s1.jpg', '2': 'https://thetvdb.test/s2.jpg', '3': 'https://thetvdb.test/s3.jpg' } }, _originalLanguage: 'ja', videos: [{ id: 'tt0000005:1:1', season: 1, episode: 1, released: '2012-10-06T07:00:00.000Z' }, { id: 'tt0000005:2:1', season: 2, episode: 1, released: '2014-04-05T07:00:00.000Z' }, { id: 'tt0000005:3:1', season: 3, episode: 1, released: '2016-04-01T07:00:00.000Z' }] } });
    }
    if (rest.startsWith('/meta/series/tt0000004')) return respond(res, { meta: { id: 'tt0000004', imdb_id: 'tt0000004', type: 'series', name: 'Série Normal', _originalLanguage: 'en', genres: ['Drama'], videos: [] } });
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
    jikanFailures = 0;
    jikanNoScore = false;
    malRetry.delays = [0, 0]; // sem esperar de verdade entre as tentativas
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

  const malScore = async (id: string) => json(await get(`malscore?id=${id}`));

  it('o detalhe do anime traz o id do MAL mas não espera a nota; a nota vem à parte (malscore) e depois já vem junto', async () => {
    const first = await json(await get(`meta?type=anime&id=${encodeURIComponent('mal:5114')}`));
    expect(first.meta).toMatchObject({ malId: '5114' });
    expect(first.meta.malScore).toBeUndefined();
    expect(hits['/jikan/anime/5114']).toBeUndefined(); // o detalhe não foi à API do MAL

    expect(await malScore('5114')).toEqual({ score: 8.25, scoredBy: 1607019, rank: 400, failed: false });
    expect(hits['/jikan/anime/5114']).toBe(1);

    // guardada: o detalhe seguinte já traz a nota e a rota não volta à API
    const again = await json(await get(`meta?type=anime&id=${encodeURIComponent('mal:5114')}`));
    expect(again.meta).toMatchObject({ malScore: 8.25, malRank: 400, malScoredBy: 1607019 });
    await malScore('5114');
    expect(hits['/jikan/anime/5114']).toBe(1);
  });

  it('item do IMDb com _malId no detalhe também tem o id do MAL para a nota', async () => {
    const body = await json(await get('meta?type=series&id=tt0000001'));
    expect(body.meta).toMatchObject({ id: 'tt0000001', malId: '5114' });
    expect((await malScore('5114')).score).toBe(8.25);
  });

  it('título do IMDb que é anime (idioma original ja) acha o id do MAL pela busca de anime da fonte', async () => {
    const body = await json(await get('meta?type=series&id=tt0000002'));
    // o item com o mesmo IMDb e a 1ª temporada na ordem da fonte (mal:777, não o mal:99 de outro IMDb)
    expect(body.meta).toMatchObject({ id: 'tt0000002', malId: '777' });
    expect((await malScore('777')).score).toBe(8.25);
  });

  it('anime do IMDb com várias entradas no MAL: cada temporada fica com a entrada que estreou no mesmo ano, não com a ordem do id (OVA e partes sobram)', async () => {
    const body = await json(await get('meta?type=series&id=tt0000005'));
    // pela ordem do id seriam 1:100, 2:200 (a OVA), 3:300, 4:350; pelo ano: T1 2012 -> 100 (a OVA 200 é do mesmo ano, mas com id maior), T2 2014 -> 300, T3 2016 -> 400
    expect(body.meta.seasonMalIds).toEqual({ '1': '100', '2': '300', '3': '400' });
    expect(body.meta.malId).toBe('100');
  });

  it('regroupSeasons: anime inteiro numa temporada vira as temporadas da TheTVDB (formato real de Jujutsu Kaisen)', async () => {
    const { regroupSeasons } = await import('../catalog');
    const day = (n: number) => new Date(Date.UTC(2020, 9, 3) + n * 7 * 86_400_000).toISOString();
    // item: 59 episódios na temporada 1 e um especial; TheTVDB: 24 + 23 + 12 (datas um dia antes, fuso) e um futuro sem data
    const episodes = [
      { id: 'tt1:0:1', season: 0, episode: 1, title: 'Especial', released: day(0) },
      ...Array.from({ length: 59 }, (_, i) => ({ id: `tt1:1:${i + 1}`, season: 1, episode: i + 1, title: `Ep ${i + 1}`, thumbnail: `https://t/${i + 1}.jpg`, released: day(i) })),
    ];
    const sizes = [24, 23, 12];
    const tvdb = sizes.flatMap((n, s) => Array.from({ length: n }, (_, i) => ({ id: `tt1:${s + 1}:${i + 1}`, season: s + 1, episode: i + 1, released: day(sizes.slice(0, s).reduce((a, b) => a + b, 0) + i) })));
    tvdb.forEach((v) => (v.released = new Date(Date.parse(v.released) - 86_400_000).toISOString()));
    tvdb.push({ id: 'tt1:4:1', season: 4, episode: 1, released: '' });

    const out = regroupSeasons(episodes, tvdb)!;
    expect(out).toBeDefined();
    const count = (s: number) => out.filter((e) => e.season === s).length;
    expect([count(0), count(1), count(2), count(3)]).toEqual([1, 24, 23, 12]);
    const ep25 = out.find((e) => e.title === 'Ep 25')!;
    expect(ep25).toMatchObject({ id: 'tt1:2:1', season: 2, episode: 1, thumbnail: 'https://t/25.jpg' }); // título e miniatura do item
    expect(out.find((e) => e.title === 'Ep 59')).toMatchObject({ season: 3, episode: 12 });
    expect(out.find((e) => e.season === 0)!.id).toBe('tt1:0:1');

    // Não mexe quando não dá para ter certeza
    expect(regroupSeasons(episodes, tvdb.slice(0, 40))).toBeUndefined(); // TheTVDB com menos episódios
    expect(regroupSeasons(episodes, tvdb.filter((v) => v.season === 1))).toBeUndefined(); // TheTVDB também com uma temporada só
    expect(regroupSeasons(episodes, tvdb.map((v) => (v.released ? { ...v, released: '2001-01-01T00:00:00.000Z' } : v)))).toBeUndefined(); // datas não batem
    expect(regroupSeasons(out, tvdb)).toBeUndefined(); // já dividido
    expect(regroupSeasons(episodes, undefined)).toBeUndefined();
  });

  it('matchSeasonsToMal: entrada de um ano antes da temporada, partes e OVAs (dados reais de JoJo)', async () => {
    const { matchSeasonsToMal } = await import('../catalog');
    // anos em que cada temporada do IMDb foi ao ar e as entradas do MAL (id: ano de estreia)
    const seasons = { 1: { from: 2012, to: 2013 }, 2: { from: 2014, to: 2015 }, 3: { from: 2016, to: 2017 }, 4: { from: 2018, to: 2019 }, 5: { from: 2022, to: 2022 }, 6: { from: 2026, to: 2026 } };
    const entries = [[61469, 2026], [51367, 2022], [48661, 2021], [37991, 2018], [31933, 2016], [26055, 2015], [20899, 2014], [14719, 2012], [53273, 2022]].map(([id, year]) => ({ id: String(id), year }));
    // a 5ª temporada é a Stone Ocean: a 1ª parte (2021) vence as partes de 2022; a 2ª parte da 2ª temporada (2015) não vira a 3ª
    expect(matchSeasonsToMal(seasons, entries)).toEqual({ '1': '14719', '2': '20899', '3': '31933', '4': '37991', '5': '48661', '6': '61469' });
    expect(matchSeasonsToMal({}, entries)).toEqual({});
    expect(matchSeasonsToMal(seasons, [{ id: '9' }])).toEqual({}); // sem ano na busca, nada a ligar
  });

  it('o item mal: também liga as temporadas (a fonte devolve a série inteira por qualquer entrada) e mantém o próprio id como o principal', async () => {
    const body = await json(await get(`meta?type=series&id=${encodeURIComponent('mal:300')}`));
    expect(body.meta.seasonMalIds).toEqual({ '1': '100', '2': '300', '3': '400' });
    expect(body.meta.malId).toBe('300');
  });

  it('item do IMDb: a arte do MAL (ocidental) vale no lugar da japonesa, no pôster da série e no de cada temporada', async () => {
    const body = await json(await get('meta?type=series&id=tt0000005'));
    expect(body.meta.poster).toBe('https://thetvdb.test/serie.jpg');
    // A arte do próprio item segue junto para o cliente poder trocar
    expect(body.meta.altPoster).toBe('https://image.tmdb.org/japones.jpg');
    expect(body.meta.altSeasonPosters['1']).toBe('https://image.tmdb.org/s1-japones.jpg');
    // as temporadas que o MAL tem trocam; a que só o item tem (4) continua com a do item
    expect(body.meta.seasonPosters).toEqual({ '1': 'https://thetvdb.test/s1.jpg', '2': 'https://thetvdb.test/s2.jpg', '3': 'https://thetvdb.test/s3.jpg', '4': 'https://image.tmdb.org/s4-japones.jpg' });
  });

  it('o meta do MAL que falha deixa só as capas do item (o detalhe responde)', async () => {
    const body = await json(await get('meta?type=series&id=tt0000002')); // mal:777 e mal:778 não têm meta no fake
    expect(body.meta).toMatchObject({ id: 'tt0000002', malId: '777' });
    expect(body.meta.seasonMalIds).toBeUndefined();
  });

  it('série que não é anime não gasta uma busca nem tem id do MAL', async () => {
    const body = await json(await get('meta?type=series&id=tt0000004'));
    expect(body.meta.malId).toBeUndefined();
    expect(Object.keys(hits).filter((p) => p.includes('search=') || p.startsWith('/jikan'))).toEqual([]);
  });

  it('a API do MAL falha na 1ª tentativa (429) e a nota vem na 2ª', async () => {
    jikanFailures = 1;
    expect(await malScore('5114')).toMatchObject({ score: 8.25, failed: false });
    expect(hits['/jikan/anime/5114']).toBe(2);
  });

  it('API do MAL fora do ar: 3 tentativas, `failed: true`, e por 1 min não insiste (o detalhe nunca esperou por isso)', async () => {
    jikanDown = true;
    const detail = await get(`meta?type=anime&id=${encodeURIComponent('mal:5114')}`);
    expect(detail.status).toBe(200);
    expect((await json(detail)).meta).toMatchObject({ name: 'Anime A', malId: '5114' });

    expect(await malScore('5114')).toEqual({ score: null, failed: true });
    expect(hits['/jikan/anime/5114']).toBe(3);
    expect(await malScore('5114')).toEqual({ score: null, failed: true });
    expect(hits['/jikan/anime/5114']).toBe(3); // dentro da janela: sem novas tentativas

    // a API volta e, passada a janela, a nota aparece
    jikanDown = false;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 90_000);
      expect(await malScore('5114')).toMatchObject({ score: 8.25, failed: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('id inválido na rota da nota: 400; anime sem nota (sem votos) não é falha', async () => {
    expect((await get('malscore?id=abc')).status).toBe(400);
    expect((await get('malscore?id=1;2')).status).toBe(400);
    jikanNoScore = true;
    expect(await malScore('42')).toEqual({ score: null, failed: false });
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
