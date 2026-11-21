import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/catalog/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/manifest')) {
      return route.fulfill({ json: { name: 'Fonte de teste', rows: [], discover: [] } });
    }
    if (url.pathname.endsWith('/meta')) {
      const id = url.searchParams.get('id');
      return route.fulfill({ json: { meta: { id, type: 'series', name: 'Anime salvo 30', genres: [], episodes: [] } } });
    }
    return route.fulfill({ json: { score: null, failed: false } });
  });
});

test('Ver tudo abre a Biblioteca inteira em uma página que pode ser recarregada', async ({ page }) => {
  const saved = Array.from({ length: 30 }, (_, i) => ({ id: `mal:${i + 1}`, type: 'series', name: `Anime salvo ${i + 1}` }));
  await page.addInitScript((items) => {
    if (!localStorage.getItem('lunio_my_list')) localStorage.setItem('lunio_my_list', JSON.stringify(items));
  }, saved);
  await page.goto('/catalog');
  const shelf = page.getByRole('region', { name: 'Biblioteca', exact: true });
  await shelf.getByRole('button', { name: 'Ver tudo', exact: true }).click({ timeout: 5000 });

  await expect(page).toHaveURL(/\/library$/, { timeout: 5000 });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
  const last = page.getByRole('button', { name: 'Anime salvo 30', exact: true });
  await last.click();
  await expect(page).toHaveURL(/\/detail\/series\/mal%3A30$/);
  await page.getByRole('button', { name: 'Biblioteca', exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(last).toBeVisible();
});

test('o atalho do catálogo abre a Biblioteca mesmo sem títulos salvos', async ({ page }) => {
  await page.goto('/catalog');
  await page.getByRole('button', { name: 'Biblioteca', exact: true }).click({ timeout: 5000 });

  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByText('Salve filmes e séries pelos detalhes de cada título.')).toBeVisible();
  await page.getByRole('button', { name: 'Catálogo', exact: true }).click();
  await expect(page).toHaveURL(/\/catalog$/);

  await page.goto('/my-list/');
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
});
