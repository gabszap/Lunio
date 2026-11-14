import { test, expect } from '@playwright/test';

test.use({ timezoneId: 'America/Halifax' });

test('calendário Sub/Dub: fuso local, lista por temporada, navegação e retorno ao catálogo', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-14T20:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('lunio_lang', 'pt');
    localStorage.setItem('lunio_my_list', JSON.stringify([{ id: 'tt123', type: 'series', name: 'Diários de uma Apotecária' }]));
  });
  await page.route('**/api/catalog/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').pop();
    const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (action === 'manifest') return json({ name: 'Fixture', rows: [], stale: false });
    if (action === 'meta') return json({ meta: { id: 'tt123', type: 'series', name: 'Diários de uma Apotecária', genres: [], malId: '54492', seasonMalIds: { '3': '61987' }, episodes: [] } });
    if (action === 'malscore') return json({ score: null, failed: false });
    if (action === 'calendar') return json({
      checkedAt: '2026-11-14T20:00:00Z', updatedAt: '2026-11-14T20:00:00Z', stale: false, failedSources: [], rangeStart: '2026-10-01T00:00:00Z', rangeEnd: '2027-02-01T00:00:00Z',
      events: [
        { key: 'sub:1:7', anilistId: 1, malId: '61987', title: 'The Apothecary Diaries Season 3', kind: 'sub', episode: 7, at: '2026-11-13T14:00:00Z', delayed: false },
        { key: 'dub:1:5', anilistId: 1, malId: '61987', title: 'The Apothecary Diaries Season 3', kind: 'dub', episode: 5, at: '2026-11-13T16:00:00Z', delayed: false },
        { key: 'sub:2:4', anilistId: 2, malId: '999', title: 'Outro anime', kind: 'sub', episode: 4, at: '2026-11-13T17:00:00Z', delayed: false },
        { key: 'sub:1:8', anilistId: 1, malId: '61987', title: 'The Apothecary Diaries Season 3', kind: 'sub', episode: 8, at: '2026-11-20T14:00:00Z', delayed: false },
      ],
    });
    return json({ metas: [] });
  });
  await page.goto('/catalog');
  await page.getByRole('button', { name: 'Calendário', exact: true }).click();
  await expect(page).toHaveURL(/calendar=1/);
  await expect(page.getByText('3 lançamentos na semana')).toBeVisible();
  await expect(page.getByRole('button', { name: /Abrir The Apothecary Diaries Season 3, episódio 7, Sub/ }).getByText('10:00')).toBeVisible();
  await expect(page.getByRole('button', { name: /Abrir Outro anime/ })).toBeVisible();
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
  await page.getByRole('button', { name: 'Catálogo', exact: true }).first().click();
  await expect(page.getByText('1 lançamento na semana')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Calendário', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Catálogo', exact: true }).click();
  await expect(page).not.toHaveURL(/calendar=/);
});
