import { test, expect } from '@playwright/test';

test.use({ timezoneId: 'America/Halifax' });

test('calendário Sub/Dub: fuso local, lista por temporada, navegação e retorno ao catálogo', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-14T20:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('lunio_lang', 'pt');
    localStorage.setItem('lunio_my_list', JSON.stringify([{ id: 'tt123', type: 'series', name: 'Diários de uma Apotecária' }]));
  });
  await page.route('**/poster.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#534176"/></svg>' }));
  const identityRequests: string[] = [];
  await page.route('**/api/catalog/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').pop();
    const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (action === 'calendar-match') { identityRequests.push('match'); return json({ 'kusuriya-no-hitorigoto-3rd-season': { malId: '61987', anilistId: 195516 } }); }
    if (action === 'calendar-identity') { identityRequests.push('identity'); return json({ malId: '61987', anilistId: 195516 }); }
    if (action === 'manifest') return json({ name: 'Fixture', rows: [], stale: false });
    if (action === 'meta') return json({ meta: { id: 'tt123', type: 'series', name: 'Diários de uma Apotecária', genres: [], malId: '54492', seasonMalIds: { '3': '61987' }, episodes: [] } });
    if (action === 'malscore') return json({ score: null, failed: false });
    if (action === 'calendar') return json({
      checkedAt: '2026-11-14T20:00:00Z', updatedAt: '2026-11-14T20:00:00Z', stale: false, failedSources: [], rangeStart: '2026-10-01T00:00:00Z', rangeEnd: '2027-02-01T00:00:00Z',
      events: [
        { key: 'sub:1:7', route: 'kusuriya-no-hitorigoto-3rd-season', title: 'The Apothecary Diaries Season 3', kind: 'sub', episode: 7, at: '2026-11-13T14:00:00Z', delayed: false, format: 'TV', platforms: ['HiDive'], popularity: 500, poster: '/poster.svg' },
        { key: 'dub:1:5', route: 'kusuriya-no-hitorigoto-3rd-season', title: 'The Apothecary Diaries Season 3', kind: 'dub', episode: 5, at: '2026-11-13T16:00:00Z', delayed: false },
        { key: 'sub:2:4', route: 'outro-anime', title: 'Outro anime', kind: 'sub', episode: 4, at: '2026-11-13T17:00:00Z', delayed: false, format: 'TV', popularity: 900, poster: '/poster.svg' },
        { key: 'sub:3:1', anilistId: 3, title: 'Donghua de teste', kind: 'sub', episode: 1, at: '2026-11-13T17:00:00Z', format: 'ONA', donghua: true },
        { key: 'sub:4:1', anilistId: 4, title: 'Curta de teste', kind: 'sub', episode: 1, at: '2026-11-13T17:00:00Z', format: 'TV_SHORT' },
        { key: 'sub:1:8', route: 'kusuriya-no-hitorigoto-3rd-season', title: 'The Apothecary Diaries Season 3', kind: 'sub', episode: 8, at: '2026-11-20T15:00:00Z', delayed: false },
      ],
    });
    return json({ metas: [] });
  });
  await page.goto('/catalog');
  await page.getByRole('button', { name: 'Calendário', exact: true }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByText('3 lançamentos na semana')).toBeVisible();
  await expect(page.getByRole('button', { name: /Abrir The Apothecary Diaries Season 3, episódio 7, Sub/ }).getByText('10:00')).toBeVisible();
  await expect(page.getByRole('button', { name: /Abrir Outro anime/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Abrir / }).first()).toHaveAccessibleName(/Outro anime/);
  const cover = await page.locator('[data-calendar-poster]').first().boundingBox();
  expect(cover!.width).toBeGreaterThan(140);
  expect(cover!.height).toBeGreaterThan(210);
  const badge = await page.getByRole('button', { name: /Abrir Outro anime/ }).getByText('Sub', { exact: true }).boundingBox();
  expect(badge!.width).toBeLessThan(44);
  expect(badge!.height).toBeLessThan(24);
  await page.getByRole('button', { name: 'Filtros', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Mostrar Donghua' }).check();
  await expect(page.getByText('4 lançamentos na semana')).toBeVisible();
  await page.getByRole('button', { name: 'Curtas de TV', exact: true }).click();
  await expect(page.getByText('5 lançamentos na semana')).toBeVisible();
  await page.getByRole('button', { name: 'Restaurar filtros', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Buscar no calendário' }).fill('Outro');
  await expect(page.getByText('1 lançamento na semana')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Buscar no calendário' }).clear();
  await page.getByRole('combobox', { name: 'Plataforma', exact: true }).selectOption('HiDive');
  await expect(page.getByText('1 lançamento na semana')).toBeVisible();
  await page.getByRole('button', { name: 'Restaurar filtros', exact: true }).click();
  await page.getByRole('switch', { name: 'Só minha lista' }).check();
  await expect(page.getByText('2 lançamentos na semana')).toBeVisible();
  await expect(page.getByRole('button', { name: /Abrir Outro anime/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Dub', exact: true }).click();
  await expect(page.getByText('1 lançamento na semana')).toBeVisible();
  await page.getByRole('tab', { name: 'Todos', exact: true }).click();
  await page.getByRole('button', { name: 'Próxima semana', exact: true }).click();
  await expect(page.getByText('1 lançamento na semana')).toBeVisible();
  await page.getByRole('button', { name: /Abrir Diários de uma Apotecária, episódio 8, Sub/ }).click();
  await expect(page).toHaveURL(/detail\/series\/tt123/);
  await expect(page).not.toHaveURL(/calendar=/);
  await page.getByRole('button', { name: 'Catálogo', exact: true }).first().click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByText('1 lançamento na semana')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Calendário', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Catálogo', exact: true }).click();
  await expect(page).not.toHaveURL(/calendar=/);
  await expect(page).toHaveURL(/\/catalog$/);
  expect(identityRequests).toContain('match');
  expect(identityRequests).toContain('identity');
  await page.goto('/catalog?calendar=1');
  await expect(page).toHaveURL(/\/calendar$/);
  await page.goto('/detail/series/mal%3A61987?calendar=1&season=1');
  await expect(page).toHaveURL(/\/detail\/series\/mal%3A61987/);
  await expect(page).not.toHaveURL(/calendar=/);
});
