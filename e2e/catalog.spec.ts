import { test, expect, type Page } from '@playwright/test';

/** Fonte simulada: o servidor do E2E não tem internet, então as rotas do catálogo são respondidas aqui. */
const MANIFEST = {
  name: 'Fonte de teste',
  isDefault: false,
  stale: false,
  rows: [
    { type: 'movie', id: 'populares', name: 'Filmes populares', genres: [] },
    { type: 'series', id: 'em-alta', name: 'Séries em alta', genres: [] },
    { type: 'anime', id: 'no-ar', name: 'Animes no ar', genres: [] },
  ],
};
const ITEMS: Record<string, any[]> = {
  populares: [{ id: 'tmdb:1', type: 'movie', name: 'Filme Um', year: '2021' }],
  'em-alta': [{ id: 'tvdb:2', type: 'series', name: 'Série Dois', year: '2022' }],
  'no-ar': [{ id: 'mal:5114', type: 'anime', name: 'Anime Três', year: '2023' }],
};
const META = {
  id: 'mal:5114', type: 'anime', name: 'Anime Três', year: '2023', genres: ['Action'], description: 'Sinopse do anime.',
  imdbId: 'tt5607616', imdbRating: '8.3', malId: '5114',
  episodes: [
    { id: 'e11', season: 1, episode: 1, title: 'Primeiro' },
    { id: 'e12', season: 1, episode: 2, title: 'Segundo' },
    { id: 'e01', season: 0, episode: 1, title: 'Especial de verão' },
  ],
};

async function mockCatalog(page: Page, opts: { manifestStatus?: number; malFailures?: number } = {}) {
  let malFailures = opts.malFailures ?? 0;
  const rowRequests: string[] = [];
  await page.route('**/api/catalog/**', async (route) => {
    const url = new URL(route.request().url());
    const action = url.pathname.split('/').pop();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'manifest') return opts.manifestStatus ? json({ error: 'x', code: 'catalog_unavailable' }, opts.manifestStatus) : json(MANIFEST);
    if (action === 'row') {
      const id = url.searchParams.get('id')!;
      rowRequests.push(id);
      return json({ metas: ITEMS[id] ?? [], stale: false });
    }
    if (action === 'meta') return json({ meta: META, stale: false });
    // A nota do MyAnimeList vem à parte (o detalhe nunca espera por ela); `failed: true` simula a API do MAL sem responder
    if (action === 'malscore') return malFailures-- > 0 ? json({ score: null, failed: true }) : json({ score: 8.25, scoredBy: 1607019, rank: 400, failed: false });
    if (action === 'search') {
      const q = url.searchParams.get('q');
      return json({
        groups: [
          { type: 'series', id: 'search.series', name: 'Series Search', metas: [{ id: 'tt0000001', type: 'series', name: `Resultado de ${q}`, year: '2016' }] },
          { type: 'anime.series', id: 'search.anime_series', name: 'Anime Series Search', metas: [{ id: 'mal:5114', type: 'series', name: `Anime de ${q}`, year: '2016' }] },
        ],
        stale: false,
      });
    }
    return json({ metas: [], stale: false });
  });
  return rowRequests;
}

const openCatalog = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('tab', { name: /Catálogo/ }).click();
};

test.describe('Catálogo (fonte configurada no servidor)', () => {
  test('as fileiras vêm do manifesto, na ordem dele; o anime entra como série e os especiais viram "Especiais"', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const rows = await mockCatalog(page);
    await openCatalog(page);

    const titles = page.locator('section[aria-label] h2');
    await expect(titles.nth(0)).toHaveText('Filmes populares');
    await expect(titles.nth(1)).toHaveText('Séries em alta');
    await expect(titles.nth(2)).toHaveText('Animes no ar');
    await expect(page.getByText('Filme Um')).toBeVisible();
    await expect(page.getByText('Anime Três')).toBeVisible();
    expect(new Set(rows)).toEqual(new Set(['populares', 'em-alta', 'no-ar']));

    // O anime abre como série: temporadas, com os especiais (temporada 0) por último
    await page.getByRole('button', { name: /Anime Três/ }).click();
    await expect(page.getByText('Série', { exact: true }).first()).toBeVisible();
    const seasons = page.getByRole('tab', { name: /Temporada|Especiais/ });
    await expect(seasons).toHaveText(['Temporada 1', 'Especiais']);
    await expect(page.getByText('1. Primeiro')).toBeVisible();
    await seasons.nth(1).click();
    await expect(page.getByText('1. Especial de verão')).toBeVisible();
    await page.close();
  });

  test('catálogo fora do ar: aviso com "Tentar de novo" e a opção de criar a sala direto', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page, { manifestStatus: 502 });
    await openCatalog(page);

    await expect(page.getByRole('heading', { name: 'O catálogo não respondeu' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Criar sala com um vídeo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
    await page.close();
  });

  test('a busca vai para o endereço (?search=), um link com ela abre direto na busca e limpar a tira do endereço', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page);
    await openCatalog(page);

    await page.getByRole('searchbox').fill('re: zero');
    await expect(page.getByText('Resultado de re: zero')).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe('re: zero');

    // Recarregar (ou abrir o link) volta para a mesma busca, já na aba Catálogo
    await page.reload();
    await expect(page.getByRole('searchbox')).toHaveValue('re: zero');
    await expect(page.getByText('Resultado de re: zero')).toBeVisible();

    // Limpar a busca tira o parâmetro do endereço
    await page.getByRole('button', { name: 'Limpar busca' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has('search')).toBe(false);

    // Trocar de aba também (a busca não fica pendurada no endereço da sala ou do status)
    await page.getByRole('searchbox').fill('naruto');
    await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe('naruto');
    await page.getByRole('tab', { name: /Status/ }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has('search')).toBe(false);
    await page.close();
  });

  test('a busca vem em grupos, um por catálogo de busca da fonte (como no Stremio)', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page);
    await openCatalog(page);

    await page.getByRole('searchbox').fill('re: zero');
    const titles = page.locator('section[aria-label] h2');
    await expect(titles).toHaveText(['Series Search', 'Anime Series Search']);
    await expect(page.getByText('Resultado de re: zero')).toBeVisible();
    await expect(page.getByText('Anime de re: zero')).toBeVisible();
    await expect(page.getByText('2 resultados')).toBeVisible();
    await page.close();
  });

  test('o título aberto vai para o endereço (?detail=tipo/id), um link com ele abre direto e fechar o tira', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page);
    await openCatalog(page);

    await page.getByRole('button', { name: /Anime Três/ }).click();
    await expect(page.getByRole('heading', { name: 'Anime Três', level: 1 })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('detail')).toBe('anime/mal:5114');
    expect(page.url()).toContain('detail=anime/mal:5114'); // legível: / e : sem codificar

    // Recarregar (ou abrir o link) volta para o mesmo título, já na aba Catálogo
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Anime Três', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'Catálogo' }).last().click();
    await expect.poll(() => new URL(page.url()).searchParams.has('detail')).toBe(false);
    await page.close();
  });

  test('o detalhe do anime mostra as marcas do IMDb e do MyAnimeList com a nota de cada um, como links', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page);
    await openCatalog(page);
    await page.getByRole('button', { name: /Anime Três/ }).click();

    const imdb = page.getByRole('link', { name: /Nota do IMDb: 8\.3/ });
    await expect(imdb).toHaveAttribute('href', 'https://www.imdb.com/title/tt5607616/');
    await expect(imdb).toHaveAttribute('target', '_blank');
    await expect(imdb).toHaveAttribute('rel', /noopener/);
    await expect(imdb.locator('svg[aria-label="IMDb"]')).toBeVisible();

    const mal = page.getByRole('link', { name: /Nota do MyAnimeList: 8\.25/ });
    await expect(mal).toHaveAttribute('href', 'https://myanimelist.net/anime/5114');
    await expect(mal).toContainText('8.25');
    await expect(mal.locator('svg[aria-label="MyAnimeList"]')).toBeVisible();
    await page.close();
  });

  test('dois modos de busca: por grupos (padrão) e unificada (tudo junto, sem repetidos, com filtro); a escolha fica guardada', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page);
    await openCatalog(page);

    await page.getByRole('searchbox').fill('re: zero');
    await expect(page.locator('section[aria-label] h2')).toHaveText(['Series Search', 'Anime Series Search']);

    await page.getByRole('tab', { name: 'Unificada' }).click();
    await expect(page.locator('section[aria-label] h2')).toHaveCount(0); // sem fileiras: uma grade só
    await expect(page.getByText('Resultado de re: zero')).toBeVisible();
    await expect(page.getByText('Anime de re: zero')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Séries · 2' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Filmes · 0' })).toBeVisible();
    await page.getByRole('tab', { name: 'Filmes · 0' }).click();
    await expect(page.getByText('Resultado de re: zero')).toHaveCount(0);

    // A escolha do modo é lembrada ao recarregar
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Unificada', selected: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Por grupos' }).click();
    await expect(page.locator('section[aria-label] h2')).toHaveText(['Series Search', 'Anime Series Search']);
    await page.close();
  });

  test('a nota do MAL vem depois do detalhe e, se a API falhar, o navegador tenta de novo sozinho', async ({ browser }) => {
    test.setTimeout(60_000);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page, { malFailures: 1 }); // a 1ª resposta é "falhou"
    await openCatalog(page);
    await page.getByRole('button', { name: /Anime Três/ }).click();

    // O detalhe já está na tela, com o selo do MAL sem nota (só o link)
    await expect(page.getByRole('heading', { name: 'Anime Três', level: 1 })).toBeVisible();
    const mal = page.getByRole('link', { name: /MyAnimeList/ });
    await expect(mal).toHaveAttribute('href', 'https://myanimelist.net/anime/5114');
    await expect(mal).not.toContainText('8.25');
    // ...e ~5 s depois a nova tentativa traz a nota
    await expect(mal).toContainText('8.25', { timeout: 15_000 });
    await page.close();
  });

  test('a temporada aberta vai para o endereço (?season=), um link com ela abre nela e fechar o título a tira', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page);
    await openCatalog(page);
    await page.getByRole('button', { name: /Anime Três/ }).click();

    await expect.poll(() => new URL(page.url()).searchParams.get('season')).toBe('1');
    await page.getByRole('tab', { name: 'Especiais' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('season')).toBe('0');
    expect(page.url()).toContain('detail=anime/mal:5114'); // o detalhe continua legível ao lado

    // Recarregar volta na mesma temporada
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Especiais', selected: true })).toBeVisible();
    await expect(page.getByText('1. Especial de verão')).toBeVisible();

    await page.getByRole('button', { name: 'Catálogo' }).last().click();
    await expect.poll(() => new URL(page.url()).searchParams.has('season')).toBe(false);
    await page.close();
  });
});
