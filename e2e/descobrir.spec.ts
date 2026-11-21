import { test, expect, type Page } from '@playwright/test';

/** Fonte simulada: o servidor do E2E não tem internet, então as rotas do catálogo são respondidas aqui. */
const MANIFEST = {
  name: 'Fonte de teste',
  isDefault: false,
  stale: false,
  rows: [
    { type: 'movie', id: 'filmes.a', name: 'Filmes A', genres: [] },
    { type: 'series', id: 'crunchyroll', name: 'Crunchyroll', genres: ['Anime'], fixedGenre: 'Anime' },
  ],
  discover: [
    { type: 'movie', id: 'filmes.a', name: 'Filmes A', genres: ['Ação', 'Drama'], genreRequired: false, paged: true },
    { type: 'movie', id: 'filmes.b', name: 'Filmes B', genres: [], genreRequired: false, paged: false },
    { type: 'series', id: 'series.c', name: 'Séries C', genres: ['Comédia', 'Drama'], genreRequired: true, paged: true },
    { type: 'series', id: 'crunchyroll', name: 'Crunchyroll', genres: ['Anime'], genreRequired: true, paged: true },
  ],
};

const PAGE = 30;
/** Duas páginas cheias e depois vazio, por catálogo+gênero (`skip` 0, 30, 60…). */
function rowItems(type: string, id: string, genre: string | null, skip: number) {
  if (skip >= PAGE * 2) return [];
  return Array.from({ length: PAGE }, (_, i) => {
    const n = skip + i + 1;
    return {
      id: `tmdb:${id}-${genre ?? 'x'}-${n}`,
      type,
      name: `${id} ${genre ?? ''} ${n}`.trim(),
      poster: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="150"%3E%3C/svg%3E',
      year: '2024',
    };
  });
}

async function mockCatalog(page: Page) {
  const rows: string[] = [];
  await page.route('**/api/catalog/**', async (route) => {
    const url = new URL(route.request().url());
    const action = url.pathname.split('/').pop();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'manifest') return json(MANIFEST);
    if (action === 'row') {
      const { searchParams: q } = url;
      rows.push(`${q.get('type')}/${q.get('id')}?genre=${q.get('genre') ?? ''}&skip=${q.get('skip') ?? ''}`);
      return json({ metas: rowItems(q.get('type')!, q.get('id')!, q.get('genre'), Number(q.get('skip') ?? 0)), stale: false });
    }
    if (action === 'meta') return json({ meta: { id: 'tmdb:filmes.a-x-1', type: 'movie', name: 'Filme aberto', genres: [], episodes: [] }, stale: false });
    return json({ metas: [], stale: false });
  });
  return rows;
}

const pick = async (page: Page, select: string, option: string) => {
  await page.getByRole('button', { name: select, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
};
const scrollToEnd = (page: Page) => page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

test.describe('Explorar (Descobrir do Stremio)', () => {
  test('Ver tudo abre a grade da prateleira escolhida e carrega além dos cartazes da home', async ({ page }) => {
    const rows = await mockCatalog(page);
    await page.goto('/catalog');
    const shelf = page.getByRole('region', { name: 'Crunchyroll', exact: true });
    await shelf.getByRole('button', { name: 'Ver tudo', exact: true }).click({ timeout: 5000 });

    await expect(page).toHaveURL(/\/discover\/series\/crunchyroll\?genre=Anime$/);
    await expect(page.getByRole('button', { name: 'Catálogo da fonte', exact: true })).toContainText('Crunchyroll');
    await expect(page.getByText('crunchyroll Anime 30', { exact: true })).toBeVisible();
    await scrollToEnd(page);
    await expect(page.getByText('crunchyroll Anime 60', { exact: true })).toBeVisible();
    expect(rows).toContain('series/crunchyroll?genre=Anime&skip=30');
    await page.getByRole('button', { name: 'Catálogo', exact: true }).click();
    await expect(page).toHaveURL(/\/catalog$/);
  });

  test('arrastar a imagem do pôster rola a prateleira e preserva o clique seguinte', async ({ page }) => {
    await mockCatalog(page);
    await page.goto('/catalog');
    const shelf = page.getByRole('region', { name: 'Filmes A', exact: true });
    const first = shelf.getByRole('button', { name: /^filmes\.a\s+1 2024$/ });
    const poster = first.locator('img');
    await expect(poster).toBeVisible();
    const { x, y, width, height } = (await poster.boundingBox())!;
    const startX = x + width * 0.8;
    const startY = y + height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 115, startY, { steps: 8 });
    await page.mouse.up();

    await expect.poll(() => first.evaluate((card) => card.getBoundingClientRect().x), { timeout: 5000 }).toBeLessThan(x - 60);
    await expect(page).toHaveURL(/\/catalog$/);
    await shelf.getByRole('button', { name: /^filmes\.a\s+2 2024$/ }).click();
    await expect(page).toHaveURL(/\/detail\/movie\/tmdb%3Afilmes\.a-x-2$/);
  });

  test('o botão abre o Explorar no primeiro catálogo e trocar tipo, catálogo e gênero recomeça a grade e atualiza o endereço', async ({ page }) => {
    const rows = await mockCatalog(page);
    await page.goto('/catalog');
    await page.getByRole('button', { name: 'Explorar' }).click();

    await expect(page).toHaveURL(/\/discover\/movie\/filmes\.a$/);
    await expect(page.getByRole('button', { name: 'Tipo', exact: true })).toContainText('Filmes');
    await expect(page.getByRole('button', { name: 'Catálogo da fonte', exact: true })).toContainText('Filmes A');
    await expect(page.getByText('filmes.a 30', { exact: true })).toBeVisible();

    // gênero opcional tem "Nenhum"; escolher um refaz o pedido com ele
    await page.getByRole('button', { name: 'Gênero', exact: true }).click();
    await expect(page.getByRole('option', { name: 'Nenhum', exact: true })).toBeVisible();
    await page.getByRole('option', { name: 'Ação', exact: true }).click();
    await expect(page).toHaveURL(/\/discover\/movie\/filmes\.a\?genre=A%C3%A7%C3%A3o$/);
    await expect(page.getByText('filmes.a Ação 1', { exact: true })).toBeVisible();
    expect(rows).toContain('movie/filmes.a?genre=Ação&skip=');

    // catálogo sem gêneros: o dropdown de gênero some
    await pick(page, 'Catálogo da fonte', 'Filmes B');
    await expect(page).toHaveURL(/\/discover\/movie\/filmes\.b$/);
    await expect(page.getByRole('button', { name: 'Gênero', exact: true })).toHaveCount(0);

    // outro tipo: vai para o primeiro catálogo dele, e o gênero obrigatório já vem escolhido (sem "Nenhum")
    await pick(page, 'Tipo', 'Séries');
    await expect(page).toHaveURL(/\/discover\/series\/series\.c\?genre=Com%C3%A9dia$/);
    await expect(page.getByRole('button', { name: 'Gênero', exact: true })).toContainText('Comédia');
    await page.getByRole('button', { name: 'Gênero', exact: true }).click();
    await expect(page.getByRole('option', { name: 'Nenhum' })).toHaveCount(0);
  });

  test('rolar até o fim carrega a próxima página (skip) e para quando a fonte esvazia', async ({ page }) => {
    const rows = await mockCatalog(page);
    await page.goto('/discover/movie/filmes.a');
    await expect(page.getByText('filmes.a 30', { exact: true })).toBeVisible();

    await scrollToEnd(page);
    await expect(page.getByText('filmes.a 60', { exact: true })).toBeVisible();
    expect(rows).toContain('movie/filmes.a?genre=&skip=30');

    // a terceira página vem vazia: não pede mais nada
    await scrollToEnd(page);
    await expect.poll(() => rows.filter((r) => r.includes('skip=60')).length).toBe(1);
    await scrollToEnd(page);
    await page.waitForTimeout(600);
    expect(rows.filter((r) => r.includes('skip=60')).length).toBe(1);
    expect(rows.some((r) => r.includes('skip=90'))).toBe(false);
  });

  test('um link direto abre já na escolha do endereço (gênero válido ou o primeiro, se o do link não existe)', async ({ page }) => {
    await mockCatalog(page);
    await page.goto('/discover/series/series.c?genre=Drama');
    await expect(page.getByRole('button', { name: 'Gênero', exact: true })).toContainText('Drama');
    await expect(page.getByText('series.c Drama 1', { exact: true })).toBeVisible();

    await page.goto('/discover/series/series.c?genre=Inventado');
    await expect(page.getByRole('button', { name: 'Gênero', exact: true })).toContainText('Comédia');
    await expect(page).toHaveURL(/genre=Com%C3%A9dia/);

    // catálogo que a fonte não tem: cai no primeiro
    await page.goto('/discover/movie/nao-existe');
    await expect(page).toHaveURL(/\/discover\/movie\/filmes\.a$/);
  });

  test('abrir um título e voltar traz o Explorar de volta com a mesma grade e o mesmo endereço', async ({ page }) => {
    const rows = await mockCatalog(page);
    await page.goto('/discover/movie/filmes.a');
    await expect(page.getByText('filmes.a 30', { exact: true })).toBeVisible();
    await scrollToEnd(page);
    await expect(page.getByText('filmes.a 60', { exact: true })).toBeVisible();
    await scrollToEnd(page);
    await expect.poll(() => rows.filter((r) => r.includes('skip=60')).length).toBe(1); // a página vazia que fecha a lista
    const before = rows.length;

    await page.getByText('filmes.a 45', { exact: true }).click();
    await expect(page).toHaveURL(/\/detail\/movie\/tmdb%3Afilmes\.a-x-45$/);
    await page.getByRole('button', { name: 'Catálogo', exact: true }).click();

    await expect(page).toHaveURL(/\/discover\/movie\/filmes\.a$/);
    await expect(page.getByText('filmes.a 60', { exact: true })).toBeVisible(); // as duas páginas continuam lá
    expect(rows.length).toBe(before); // sem recarregar nada

    // e o "Catálogo" do Explorar leva à Home do catálogo
    await page.getByRole('button', { name: 'Catálogo', exact: true }).click();
    await expect(page).toHaveURL(/\/catalog$/);
    await expect(page.getByRole('button', { name: 'Explorar' })).toBeVisible();
  });
});
