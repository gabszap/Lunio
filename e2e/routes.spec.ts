import { test, expect, type Page } from '@playwright/test';

/** Fonte simulada do catálogo (o servidor do E2E não tem internet). */
async function mockCatalog(page: Page) {
  await page.route('**/api/catalog/**', async (route) => {
    const url = new URL(route.request().url());
    const action = url.pathname.split('/').pop();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'manifest') return json({ name: 'Fonte', isDefault: false, stale: false, rows: [{ type: 'movie', id: 'pop', name: 'Filmes populares', genres: [] }] });
    if (action === 'row') return json({ metas: [{ id: 'mal:5114', type: 'anime', name: 'Anime Três', year: '2023' }] });
    if (action === 'search') return json({ groups: [{ type: 'series', id: 's', name: 'Series Search', metas: [{ id: 'tt1', type: 'series', name: 'Resultado', year: '2016' }] }], stale: false });
    if (action === 'meta') return json({ meta: { id: 'mal:5114', type: 'anime', name: 'Anime Três', genres: [], episodes: [{ id: 'a', season: 1, episode: 1, title: 'Primeiro' }, { id: 'b', season: 0, episode: 1, title: 'Especial' }] } });
    return json({ score: null, failed: false });
  });
}

const selectedTab = (page: Page, name: string) => page.getByRole('tab', { name, selected: true });
const path = (page: Page) => new URL(page.url()).pathname;
const query = (page: Page) => new URL(page.url()).search;

test.describe('Rotas da Home (/catalog, /home, /status)', () => {
  test('abrir o endereço direto cai na aba certa (/ e /home são a Sala)', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page);
    for (const [url, tab] of [['/catalog', 'Catálogo'], ['/status', 'Status'], ['/home', 'Sala'], ['/', 'Sala'], ['/rota-que-nao-existe', 'Sala']] as const) {
      await page.goto(url);
      await expect(selectedTab(page, tab), url).toBeVisible();
    }
    await page.close();
  });

  test('trocar de aba muda a rota, e o Voltar do navegador volta à aba anterior', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page);
    await page.goto('/home');

    await page.getByRole('tab', { name: 'Catálogo' }).click();
    await expect.poll(() => path(page)).toBe('/catalog');
    await page.getByRole('tab', { name: 'Status' }).click();
    await expect.poll(() => path(page)).toBe('/status');
    await page.getByRole('tab', { name: 'Sala' }).click();
    await expect.poll(() => path(page)).toBe('/home');

    await page.goBack(); // Status
    await expect(selectedTab(page, 'Status')).toBeVisible();
    await page.goBack(); // Catálogo
    await expect(selectedTab(page, 'Catálogo')).toBeVisible();
    expect(path(page)).toBe('/catalog');
    await page.close();
  });

  test('sair do catálogo estando num título e voltar abre o /catalog limpo (sem busca nem título)', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page);
    await page.goto('/catalog');

    await page.getByRole('searchbox').fill('re: zero');
    await expect.poll(() => query(page)).toContain('search=');
    await page.getByRole('button', { name: /Resultado/ }).click();
    await expect.poll(() => query(page)).toContain('detail=series/tt1');

    await page.getByRole('tab', { name: 'Sala' }).click();
    await expect.poll(() => path(page)).toBe('/home');
    expect(query(page)).toBe(''); // nada do catálogo ficou no endereço

    await page.getByRole('tab', { name: 'Catálogo' }).click();
    await expect.poll(() => path(page)).toBe('/catalog');
    expect(query(page)).toBe('');
    await expect(page.getByRole('searchbox')).toHaveValue('');
    await expect(page.getByText('Filmes populares')).toBeVisible(); // a Home do catálogo, não o título
    await page.close();
  });

  test('abrir direto um título (/catalog?detail=…&season=0), ir à Sala e voltar não reabre aquele título', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page);
    await page.goto('/catalog?detail=anime/mal:5114&season=0');
    await expect(page.getByRole('heading', { name: 'Anime Três', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Especiais', selected: true })).toBeVisible();

    await page.getByRole('tab', { name: 'Sala' }).click();
    await page.getByRole('tab', { name: 'Catálogo' }).click();
    await expect.poll(() => path(page)).toBe('/catalog');
    expect(query(page)).toBe('');
    await expect(page.getByRole('heading', { name: 'Anime Três', level: 1 })).toHaveCount(0);
    await expect(page.getByText('Filmes populares')).toBeVisible();
    await page.close();
  });

  test('o link antigo com a busca na raiz (/?search=…) abre o catálogo e vira /catalog', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page);
    await page.goto('/?search=naruto');
    await expect(selectedTab(page, 'Catálogo')).toBeVisible();
    await expect(page.getByRole('searchbox')).toHaveValue('naruto');
    await expect.poll(() => path(page)).toBe('/catalog');
    expect(query(page)).toContain('search=naruto');
    await page.close();
  });
});
