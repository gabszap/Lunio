import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { FIXTURE_URL, submitName } from './helpers';

const ADDON_PORT = 3102;
const MANIFEST_URL = `http://127.0.0.1:${ADDON_PORT}/manifest.json`;

let addon: ChildProcess;

test.beforeAll(async () => {
  addon = spawn('node', ['e2e/fake-addon.mjs', String(ADDON_PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(MANIFEST_URL)).ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('addon de teste não subiu');
});

test.afterAll(() => {
  addon?.kill();
});

/** Fonte simulada do catálogo (o servidor do E2E não tem internet). */
async function mockCatalog(page: Page) {
  await page.route('**/api/catalog/**', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').pop();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'manifest') return json({ name: 'Fonte', isDefault: false, stale: false, rows: [{ type: 'movie', id: 'pop', name: 'Filmes populares', genres: [] }] });
    if (action === 'row') return json({ metas: [] });
    return json({ groups: [], stale: false });
  });
}

test.describe('Addons de vídeo', () => {
  test('adicionar um addon, ver nome e host sem expor a URL, manter após recarregar e remover', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page);
    await page.goto('/catalog');

    await page.getByRole('button', { name: 'Addons' }).click();
    const dialog = page.getByRole('dialog', { name: 'Addons' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('URL do manifesto').fill('http://127.0.0.1:3102/nao-e-manifesto');
    await dialog.getByRole('button', { name: 'Adicionar' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Cole a URL do manifesto (termina em /manifest.json)');

    await dialog.getByLabel('URL do manifesto').fill(MANIFEST_URL);
    await dialog.getByRole('button', { name: 'Adicionar' }).click();
    await expect(dialog.getByText('Addon de teste')).toBeVisible();
    await expect(dialog.getByText(`127.0.0.1:${ADDON_PORT}`, { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('URL do manifesto')).toHaveValue('');
    expect(await page.content()).not.toContain(MANIFEST_URL);

    await dialog.getByLabel('URL do manifesto').fill(MANIFEST_URL);
    await dialog.getByRole('button', { name: 'Adicionar' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Esse addon já foi adicionado');

    await page.reload();
    await page.getByRole('button', { name: 'Addons' }).click();
    const again = page.getByRole('dialog', { name: 'Addons' });
    await expect(again.getByText('Addon de teste')).toBeVisible();

    await again.getByRole('button', { name: 'Remover' }).click();
    await expect(again.getByText('Addon de teste')).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: 'Addons' }).click();
    await expect(page.getByRole('dialog', { name: 'Addons' }).getByText('Addon de teste')).toHaveCount(0);
    await page.close();
  });

  test('falha ao atualizar aparece na linha do addon, sem marcar o campo de URL como inválido', async ({ browser }) => {
    const port = 3103;
    const url = `http://127.0.0.1:${port}/manifest.json`;
    const second = spawn('node', ['e2e/fake-addon.mjs', String(port)], { stdio: 'ignore' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      for (let i = 0; i < 50; i++) {
        try {
          if ((await fetch(url)).ok) break;
        } catch {
          // ainda subindo
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      await mockCatalog(page);
      await page.goto('/catalog');
      await page.getByRole('button', { name: 'Addons' }).click();
      const dialog = page.getByRole('dialog', { name: 'Addons' });
      await dialog.getByLabel('URL do manifesto').fill(url);
      await dialog.getByRole('button', { name: 'Adicionar' }).click();
      await expect(dialog.getByText(`127.0.0.1:${port}`, { exact: true })).toBeVisible();

      second.kill();
      await expect.poll(() => fetch(url).then(() => true, () => false)).toBe(false);
      await dialog.getByRole('button', { name: 'Atualizar Addon de teste' }).click();
      await expect(dialog.getByRole('alert')).toHaveText('Não consegui abrir esse endereço');
      await expect(dialog.getByLabel('URL do manifesto')).not.toHaveAttribute('aria-invalid', 'true');
      await dialog.getByRole('button', { name: 'Remover Addon de teste' }).click();
    } finally {
      second.kill();
      await page.close();
    }
  });
});

// ───────────── streams no detalhe ─────────────

const SERIES_META = {
  id: 'tt2',
  type: 'series',
  name: 'Série Dois',
  genres: [],
  episodes: [
    { id: 'tt2:1:1', season: 1, episode: 1, title: 'Primeiro' },
    { id: 'tt2:1:2', season: 1, episode: 2, title: 'Segundo' },
  ],
};
const MOVIE_META = { id: 'tt1', type: 'movie', name: 'Filme Um', genres: [], episodes: [] };

/** Catálogo simulado com um filme (tt1) e uma série (tt2). */
async function mockTitles(page: Page) {
  await page.route('**/api/catalog/**', async (route) => {
    const url = new URL(route.request().url());
    const action = url.pathname.split('/').pop();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'manifest') return json({ name: 'Fonte', isDefault: false, stale: false, rows: [] });
    if (action === 'meta') return json({ meta: url.searchParams.get('id') === 'tt1' ? MOVIE_META : SERIES_META });
    return json({ score: null, failed: false });
  });
}

/** Deixa o addon de teste já guardado no navegador (o painel é coberto pelos testes acima). */
async function withAddon(page: Page) {
  await page.addInitScript(
    ([key, manifestUrl, base]) => {
      if (localStorage.getItem(key) !== null) return;
      localStorage.setItem(key, JSON.stringify([{ id: 'fake1', name: 'Addon de teste', manifestUrl, base, stream: { types: ['movie', 'series'], idPrefixes: ['tt'] } }]));
    },
    ['lunio_addons', MANIFEST_URL, `http://127.0.0.1:${ADDON_PORT}`] as const
  );
}

const path = (page: Page) => new URL(page.url()).pathname;
const query = (page: Page) => new URL(page.url()).search;

test.describe('Streams no detalhe (Onde assistir)', () => {
  test('filme: lista ordenada, o que não toca fica recolhido e o clique cria a sala', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await withAddon(page);
    await mockTitles(page);
    await page.goto('/detail/movie/tt1');

    await expect(page.getByRole('heading', { name: 'Onde assistir' })).toBeVisible();
    const h264 = page.getByRole('button', { name: /Filme\.1080p\.H264\.mkv/ });
    await expect(h264).toBeVisible();
    await expect(h264).toContainText('Toca');
    // A ordem é Toca, Pode falhar: o H.264 vem antes do HEVC
    const names = await page.locator('section', { has: page.getByRole('heading', { name: 'Onde assistir' }) }).getByRole('button').allTextContents();
    expect(names.findIndex((n) => /H264/.test(n))).toBeLessThan(names.findIndex((n) => /HEVC/.test(n)));
    // O que o addon avisa que não é para navegador fica atrás de "Mostrar o resto"
    await expect(page.getByRole('button', { name: /Filme\.720p\.mkv/ })).toHaveCount(0);
    await page.getByRole('button', { name: /Mostrar o resto/ }).click();
    await expect(page.getByRole('button', { name: /Filme\.720p\.mkv/ })).toContainText('Não toca');
    // A URL do stream nunca aparece
    expect(await page.content()).not.toContain('127.0.0.1:3101');

    await h264.click();
    await submitName(page, 'Ana');
    await expect(page).toHaveURL(/\?room=[A-Z0-9]+/);
    await expect(page.locator('video')).toBeAttached();
    await page.close();
  });

  test('episódio: o caminho leva o videoId, abrir direto mostra os streams e Voltar volta à lista', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await withAddon(page);
    await mockTitles(page);
    await page.goto('/detail/series/tt2');

    await page.getByRole('button', { name: /Primeiro/ }).click();
    await expect.poll(() => path(page)).toBe('/detail/series/tt2/tt2%3A1%3A1');
    expect(query(page)).toContain('season=1');
    await expect(page.getByRole('button', { name: /Filme\.1080p\.H264\.mkv/ })).toBeVisible();

    await page.getByRole('button', { name: 'Episódios' }).click();
    await expect.poll(() => path(page)).toBe('/detail/series/tt2');
    await expect(page.getByRole('button', { name: /Segundo/ })).toBeVisible();

    await page.goto('/detail/series/tt2/tt2%3A1%3A2');
    await expect(page.getByRole('button', { name: /Filme\.1080p\.H264\.mkv/ })).toBeVisible();
    await expect.poll(() => path(page)).toBe('/detail/series/tt2/tt2%3A1%3A2');
    await page.close();
  });

  test('trocar de episódio não deixa a resposta atrasada do anterior na lista', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await withAddon(page);
    await mockTitles(page);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    // A resposta do episódio 1 só sai depois que a lista do episódio 2 está na tela
    let releaseEp1!: () => void;
    const ep1Gate = new Promise<void>((r) => (releaseEp1 = r));
    let ep1Requested = false;
    let ep1Fulfilled = false;
    await page.route('**/stream/series/tt2%3A1%3A1.json', async (route) => {
      ep1Requested = true;
      await ep1Gate;
      await route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ streams: [{ name: 'Tardio', title: 'EP1-TARDIO.mkv', url: 'http://127.0.0.1:3101/teste.mkv' }] }) });
      ep1Fulfilled = true;
    });
    await page.route('**/stream/series/tt2%3A1%3A2.json', (route) =>
      route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ streams: [{ name: 'Rápido', title: 'EP2-OK.mkv', url: 'http://127.0.0.1:3101/teste.mkv' }] }) })
    );
    await page.goto('/detail/series/tt2');

    await page.getByRole('button', { name: /Primeiro/ }).click();
    await page.getByRole('button', { name: 'Episódios' }).click();
    await page.getByRole('button', { name: /Segundo/ }).click();
    await expect(page.getByRole('button', { name: /EP2-OK/ })).toBeVisible();
    expect(ep1Requested).toBe(true);
    releaseEp1();
    await expect.poll(() => ep1Fulfilled).toBe(true);
    // Dá ao navegador a chance de processar a resposta entregue antes de checar que ela foi descartada
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await expect(page.getByText('EP1-TARDIO')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /EP2-OK/ })).toBeVisible();
    await page.close();
  });

  test('sem nenhum addon aparece o convite, que abre o painel', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockTitles(page);
    await page.goto('/detail/movie/tt1');
    await page.getByRole('button', { name: 'Adicionar um addon' }).click();
    await expect(page.getByRole('dialog', { name: 'Addons' })).toBeVisible();
    await page.close();
  });
});

// ───────────── menu de episódios dentro do player ─────────────

/** Abre o episódio 1 pelo detalhe, escolhe o stream H.264 e chega ao player (o contexto da série fica guardado). */
async function playEpisodeOne(page: Page) {
  await withAddon(page);
  await mockTitles(page);
  await page.goto('/detail/series/tt2/tt2%3A1%3A1');
  await page.getByRole('button', { name: /Filme\.1080p\.H264\.mkv/ }).click();
  await submitName(page, 'Ana');
  await expect(page).toHaveURL(/\?room=[A-Z0-9]+/);
  await expect(page.locator('video')).toBeAttached();
}

const episodesToggle = (page: Page) => page.locator('#btn-episodes-menu-toggle');
const episodesOverlay = (page: Page) => page.locator('#player-episodes-overlay');

test.describe('Menu de episódios no player', () => {
  test('o botão que abre o overlay também o fecha (o clique não reabre)', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await playEpisodeOne(page);
    await page.mouse.move(640, 360); // mostra os controles

    await episodesToggle(page).click();
    await expect(episodesOverlay(page)).toBeVisible();
    await episodesToggle(page).click();
    await expect(episodesOverlay(page)).toHaveCount(0);
    await page.waitForTimeout(300); // um reabrir tardio apareceria aqui
    await expect(episodesOverlay(page)).toHaveCount(0);
    await page.close();
  });

  test('um vídeo que não veio de um episódio (link colado) tira o menu de episódios, mesmo depois de recarregar', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await playEpisodeOne(page);
    await page.mouse.move(640, 360); // mostra os controles
    await expect(episodesToggle(page)).toBeVisible();

    // O contexto da série fica no sessionStorage: recarregar a Home o traz de volta ao estado e o link colado tem de descartá-lo
    await page.goto('/');
    await page.getByRole('button', { name: /Colar link de stream/ }).click();
    await page.getByRole('textbox', { name: 'URL do stream' }).fill(FIXTURE_URL);
    await page.getByRole('button', { name: 'Criar sala' }).click();
    await submitName(page, 'Ana');
    await expect(page).toHaveURL(/\?room=[A-Z0-9]+/);
    await expect(page.locator('video')).toBeAttached();
    await page.mouse.move(640, 360); // mostra os controles
    await expect(episodesToggle(page)).toHaveCount(0);
    await page.close();
  });

  test('sem addons o escolher episódio explica o que fazer, em vez de ficar em branco', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await playEpisodeOne(page);
    await page.evaluate(() => localStorage.removeItem('lunio_addons'));
    await page.mouse.move(640, 360); // mostra os controles
    await episodesToggle(page).click();
    await episodesOverlay(page).getByText('Segundo').click();
    await expect(episodesOverlay(page).getByText('Nenhum addon configurado. Adicione um na aba Catálogo.')).toBeVisible();
    await page.close();
  });

  test('Espaço numa linha de episódio abre as fontes e não dá play/pause no vídeo', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await playEpisodeOne(page);
    await page.mouse.move(640, 360); // mostra os controles
    await episodesToggle(page).click();
    const before = await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused);

    await episodesOverlay(page).getByRole('button', { name: /Segundo/ }).focus();
    await page.keyboard.press('Space');
    await expect(episodesOverlay(page).getByText('Escolha uma fonte para assistir')).toBeVisible();
    expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(before);
    await page.close();
  });
});
