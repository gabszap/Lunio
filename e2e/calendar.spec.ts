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
    const url = new URL(route.request().url());
    const action = url.pathname.split('/').pop();
    const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (action === 'calendar-match') { identityRequests.push('match'); return json({ matches: { 'kusuriya-no-hitorigoto-3rd-season': { malId: '61987', anilistId: 195516 } }, incomplete: false }); }
    if (action === 'calendar-identity') { identityRequests.push('identity'); return json({ malId: '61987', anilistId: 195516 }); }
    if (action === 'manifest') return json({ name: 'Fixture', rows: [], stale: false });
    if (action === 'meta') return json({ meta: {
      id: 'tt123', type: 'series', name: 'Diários de uma Apotecária', genres: [], malId: '54492',
      seasonMalIds: { '1': '54492', '3': '61987' }, seriesMalIds: ['54492', '58514', '61987'],
      episodes: [
        { id: 'tt123:1:1', season: 1, episode: 1, title: 'Primeira temporada' },
        { id: 'tt123:3:8', season: 3, episode: 8, title: 'Lançamento da terceira temporada' },
      ],
    } });
    if (action === 'malscore') return json({ score: null, failed: false });
    if (action === 'calendar') return json({
      checkedAt: '2026-11-14T20:00:00Z', updatedAt: '2026-11-14T20:00:00Z', stale: false, failedSources: [], rangeStart: '2026-10-01T00:00:00Z', rangeEnd: '2027-02-01T00:00:00Z',
      navigation: { current: url.searchParams.get('date'), previous: '2026-11-02', next: url.searchParams.get('date') === '2026-11-09' ? '2026-11-16' : null },
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
  // A conferência dos salvos começa com a agenda, antes de o filtro ser acionado.
  await expect.poll(() => identityRequests.filter(request => request === 'match').length).toBe(1);
  const activeFilters = page.getByRole('region', { name: 'Filtros ativos' });
  await expect(activeFilters.getByText('Sem Donghua', { exact: true })).toBeVisible();
  await expect(activeFilters.getByText('TV', { exact: true })).toBeVisible();
  await expect(activeFilters.getByText('ONA', { exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox')).toHaveCount(0);
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
  const settings = page.getByRole('region', { name: 'Filtros do calendário' });
  await expect(settings.getByRole('heading', { name: 'Configurações' })).toBeVisible();
  const sorting = settings.getByRole('group', { name: 'Ordenar por' });
  await sorting.getByRole('button', { name: 'Horário', exact: true }).click();
  await expect(sorting.getByRole('button', { name: 'Horário', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await sorting.getByRole('button', { name: 'Popularidade', exact: true }).click();
  await settings.getByRole('group', { name: 'Formato do horário' }).getByRole('button', { name: '12h', exact: true }).click();
  await expect(page.getByRole('button', { name: /Abrir The Apothecary Diaries Season 3, episódio 7, Sub/ }).getByText(/10:00.*AM/i)).toBeVisible();
  await settings.getByRole('group', { name: 'Capas', exact: true }).getByRole('button', { name: 'Ocultar', exact: true }).click();
  await expect(page.locator('[data-calendar-poster]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: /Abrir The Apothecary Diaries Season 3, episódio 7, Sub/ }).getByText(/10:00.*AM/i)).toBeVisible();
  await expect(page.locator('[data-calendar-poster]')).toHaveCount(0);
  await expect.poll(() => identityRequests.filter(request => request === 'match').length).toBe(2);
  await page.getByRole('button', { name: 'Filtros', exact: true }).click();
  await settings.getByRole('group', { name: 'Capas', exact: true }).getByRole('button', { name: 'Mostrar', exact: true }).click();
  await expect(page.locator('[data-calendar-poster]')).toHaveCount(2);
  await settings.getByRole('group', { name: 'Ocultar Sub quando' }).getByRole('button', { name: 'Houver Dub' }).click();
  await expect(page.getByText('2 lançamentos na semana')).toBeVisible();
  await settings.getByRole('group', { name: 'Tipo de lançamento', exact: true }).getByRole('button', { name: 'Sub', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Sub', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('2 lançamentos na semana')).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Houver Dub' })).toBeDisabled();
  await settings.getByRole('group', { name: 'Tipo de lançamento', exact: true }).getByRole('button', { name: 'Todos', exact: true }).click();
  await settings.getByRole('group', { name: 'Ocultar Sub quando' }).getByRole('button', { name: 'Houver Dub' }).click();
  await settings.getByRole('group', { name: 'Donghua' }).getByRole('button', { name: 'Mostrar', exact: true }).click();
  await expect(page.getByText('4 lançamentos na semana')).toBeVisible();
  await page.getByRole('button', { name: 'Curtas de TV', exact: true }).click();
  await expect(page.getByText('5 lançamentos na semana')).toBeVisible();
  await page.getByRole('button', { name: 'Restaurar filtros', exact: true }).click();
  await settings.getByRole('button', { name: 'HiDive', exact: true }).click();
  await expect(page.getByText('1 lançamento na semana')).toBeVisible();
  await expect(settings.getByRole('button', { name: 'HiDive', exact: true }).locator('img')).toHaveAttribute('src', '/streaming-icons/hidive.svg');
  await expect(activeFilters.getByText('HiDive', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Restaurar filtros', exact: true }).click();
  await settings.getByRole('button', { name: 'Fechar filtros', exact: true }).click();
  await expect(settings).toHaveCount(0);
  const myListFilter = page.getByRole('button', { name: 'Minha lista', exact: true });
  await myListFilter.click();
  await expect(page.getByText('2 lançamentos na semana')).toBeVisible();
  await expect(page.getByRole('button', { name: /Abrir Outro anime/ })).toHaveCount(0);
  await myListFilter.click();
  await expect(page.getByText('3 lançamentos na semana')).toBeVisible();
  await myListFilter.click();
  await expect(page.getByText('2 lançamentos na semana')).toBeVisible();
  await page.getByRole('tab', { name: 'Dub', exact: true }).click();
  await expect(page.getByText('1 lançamento na semana')).toBeVisible();
  await page.getByRole('tab', { name: 'Todos', exact: true }).click();
  expect(identityRequests.filter(request => request === 'match')).toHaveLength(2);
  await page.getByRole('button', { name: 'Próxima semana', exact: true }).click();
  await expect(page.getByText('1 lançamento na semana')).toBeVisible();
  await expect.poll(() => identityRequests.filter(request => request === 'match').length).toBe(3);
  await page.getByRole('button', { name: /Abrir The Apothecary Diaries Season 3, episódio 8, Sub/ }).click();
  await expect(page).toHaveURL(/detail\/series\/tt123\?season=3$/);
  await expect(page.getByRole('tab', { name: 'Temporada 3', selected: true })).toBeVisible();
  await expect(page.getByText('Lançamento da terceira temporada', { exact: false })).toBeVisible();
  await expect(page).not.toHaveURL(/calendar=/);
  await page.getByRole('button', { name: 'Catálogo', exact: true }).first().click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByText('1 lançamento na semana')).toBeVisible();
  expect(identityRequests.filter(request => request === 'match')).toHaveLength(3);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Calendário', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Minha lista', exact: true, pressed: true })).toBeVisible();
  await expect(page.getByText('2 lançamentos na semana')).toBeVisible();
  await page.getByRole('button', { name: 'Minha lista', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Minha lista', exact: true, pressed: false })).toBeVisible();
  await expect(page.getByText('3 lançamentos na semana')).toBeVisible();
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

test('Minha lista reúne temporadas pelo IMDb e preserva somente os lançamentos publicados na fonte', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-14T20:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('lunio_lang', 'pt');
    localStorage.setItem('lunio_my_list', JSON.stringify([
      { id: 'tt26743760', type: 'series', name: 'Diários de uma Apotecária' },
      { id: 'mal:21', type: 'series', name: 'One Piece' },
    ]));
  });
  await page.route('**/api/catalog/**', route => {
    const url = new URL(route.request().url());
    const action = url.pathname.split('/').pop();
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'manifest') return json({ name: 'Fixture', rows: [], stale: false });
    if (action === 'meta') {
      const id = url.searchParams.get('id');
      return json({ meta: { id, type: 'series', name: id === 'mal:21' ? 'One Piece' : 'Diários de uma Apotecária', genres: [],
        episodes: [{ id: `${id}:1:1`, season: 1, episode: 1, title: 'Primeiro episódio' }],
        ...(id === 'mal:21' ? { malId: '21' } : { malId: '54492', seasonMalIds: { '1': '54492' }, seriesMalIds: ['54492', '58514', '61987'] }),
      } });
    }
    if (action === 'calendar-identity') return json({ malId: '61987' });
    if (action === 'malscore') return json({ score: null, failed: false });
    if (action === 'calendar-match') {
      const ids = url.searchParams.get('ids')?.split(',') ?? [];
      return json({ matches: { ...(ids.includes('61987') ? { 'kusuriya-no-hitorigoto-zoku-hen': { malId: '61987' } } : {}), ...(ids.includes('21') ? { 'one-piece': { malId: '21' } } : {}) }, incomplete: false });
    }
    if (action === 'calendar') return json({ checkedAt: '2026-11-14T20:00:00Z', updatedAt: '2026-11-14T20:00:00Z', stale: false, failedSources: [], rangeStart: '2026-10-01T00:00:00Z', rangeEnd: '2027-02-01T00:00:00Z', navigation: { current: '2026-11-09', previous: '2026-11-02', next: '2026-11-16' }, events: [
      { key: 'apo-sub', route: 'kusuriya-no-hitorigoto-zoku-hen', title: 'The Apothecary Diaries Season 3', kind: 'sub', episode: 7, at: '2026-11-13T15:00:00Z', format: 'TV' },
      { key: 'apo-dub', route: 'kusuriya-no-hitorigoto-zoku-hen', title: 'The Apothecary Diaries Season 3', kind: 'dub', episode: 5, at: '2026-11-13T16:40:00Z', format: 'TV' },
      { key: 'op-dub', route: 'one-piece', title: 'One Piece', kind: 'dub', episode: 1159, at: '2026-11-10T17:00:00Z', format: 'TV' },
      { key: 'other-sub', route: 'other', title: 'Outro anime', kind: 'sub', episode: 1, at: '2026-11-14T15:00:00Z', format: 'TV' },
    ] });
    return json({ metas: [] });
  });
  await page.goto('/calendar');
  await expect(page.getByText('4 lançamentos na semana')).toBeVisible();
  await page.getByRole('button', { name: 'Minha lista', exact: true }).click();
  await expect(page.getByText('3 lançamentos na semana')).toBeVisible();
  await expect(page.getByRole('button', { name: /Abrir The Apothecary Diaries Season 3, episódio 7, Sub/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Abrir The Apothecary Diaries Season 3, episódio 5, Dub/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Abrir One Piece, episódio 1159, Dub/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Abrir One Piece,.*Sub/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Abrir Outro anime/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: /sábado, 14 de novembro/ })).toHaveAttribute('aria-current', 'date');
  await page.getByRole('button', { name: /Abrir The Apothecary Diaries Season 3, episódio 7, Sub/ }).click();
  await expect(page).toHaveURL(/detail\/series\/tt26743760\?season=1$/);
  await expect(page.getByRole('tab', { name: 'Temporada 1', selected: true })).toBeVisible();
  await page.getByRole('button', { name: 'Catálogo', exact: true }).first().click();
  await expect(page).toHaveURL(/\/calendar$/);
  // Alteração real do localStorage em outra aba, sem recarregar o calendário atual.
  const otherTab = await page.context().newPage();
  await otherTab.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html><title>Minha lista</title></html>' }));
  await otherTab.goto('/list-test');
  await otherTab.evaluate(() => localStorage.setItem('lunio_my_list', JSON.stringify([{ id: 'mal:21', type: 'series', name: 'One Piece' }])));
  await expect(page.getByText('1 lançamento na semana')).toBeVisible();
  await expect(page.getByRole('button', { name: /Abrir The Apothecary Diaries/ })).toHaveCount(0);
  await otherTab.close();
});

test('a navegação para no limite da fonte e continua funcionando em semanas sem resultados', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-30T20:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('lunio_lang', 'pt'));
  const requests: string[] = [];
  await page.route('**/api/catalog/**', route => {
    const url = new URL(route.request().url());
    const action = url.pathname.split('/').pop();
    if (action !== 'calendar') return route.fulfill({ json: { name: 'Fixture', rows: [], metas: [] } });
    const current = url.searchParams.get('date')!;
    requests.push(current);
    return route.fulfill({ json: { events: [], stale: false, failedSources: [], checkedAt: '2026-11-30T20:00:00Z', updatedAt: '2026-11-30T20:00:00Z', rangeStart: '2026-10-01T00:00:00Z', rangeEnd: '2027-03-01T00:00:00Z',
      navigation: { current, previous: current === '2026-11-30' ? '2026-11-23' : '2026-11-16', next: current === '2026-11-30' ? null : '2026-11-30' },
    } });
  });
  await page.goto('/calendar');
  await expect(page.getByText('0 lançamentos na semana')).toBeVisible();
  const next = page.getByRole('button', { name: 'Próxima semana', exact: true });
  const previous = page.getByRole('button', { name: 'Semana anterior', exact: true });
  await expect(next).toBeDisabled();
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(next).toBeDisabled();
  await page.getByRole('region', { name: 'Informações da agenda' }).getByRole('button', { name: 'Atualizar agenda', exact: true }).click();
  await expect.poll(() => requests.length).toBe(4);
  expect(requests).toEqual(['2026-11-30', '2026-11-23', '2026-11-30', '2026-11-30']);
});

test('35 temporadas: abas não quebram e a última temporada é alcançável com os controles e no celular', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('lunio_lang', 'pt'));
  await page.route('**/api/catalog/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').pop();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(action === 'meta' ? { meta: {
      id: 'mal:235', type: 'series', name: 'Detective Conan', genres: [], malId: '235',
      episodes: Array.from({ length: 35 }, (_, index) => ({ id: `conan:${index + 1}:1`, season: index + 1, episode: 1, title: `Caso da temporada ${index + 1}` })),
    } } : { name: 'Fixture', rows: [], metas: [], score: null, failed: false }) });
  });
  await page.goto('/detail/series/mal%3A235?season=1');
  const tabs = page.getByRole('tablist', { name: 'Temporadas' });
  const first = tabs.getByRole('tab', { name: 'Temporada 1', exact: true });
  await expect(first).toBeVisible();
  const firstBox = await first.boundingBox();
  expect(firstBox!.height).toBeLessThan(45);
  const next = page.getByRole('button', { name: 'Próximas temporadas', exact: true });
  await next.click();
  await expect.poll(() => tabs.evaluate(el => el.scrollLeft)).toBeGreaterThan(100);
  await tabs.getByRole('tab', { name: 'Temporada 35', exact: true }).click();
  await expect(page.getByText('1. Caso da temporada 35', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/season=35/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(tabs.getByRole('tab', { name: 'Temporada 35', exact: true })).toBeInViewport();
  await expect(page.getByText('1. Caso da temporada 35', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
