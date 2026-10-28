import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { state, submitName, video, waitReady } from './helpers';

const ADDON_PORT = 3104;
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
test.afterAll(() => addon?.kill());

const SERIES_META = {
  id: 'tt2',
  type: 'series',
  name: 'Série Dois',
  poster: 'https://img.test/serie.jpg',
  genres: [],
  episodes: [
    { id: 'tt2:1:1', season: 1, episode: 1, title: 'Primeiro' },
    { id: 'tt2:1:2', season: 1, episode: 2, title: 'Segundo' },
  ],
};

async function setup(page: Page) {
  await page.addInitScript(
    ([key, manifestUrl, base]) => {
      if (localStorage.getItem(key) !== null) return;
      localStorage.setItem(key, JSON.stringify([{ id: 'fake1', name: 'Addon de teste', manifestUrl, base, stream: { types: ['movie', 'series'], idPrefixes: ['tt'] } }]));
    },
    ['lunio_addons', MANIFEST_URL, `http://127.0.0.1:${ADDON_PORT}`] as const
  );
  await page.route('**/api/catalog/**', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').pop();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'manifest') return json({ name: 'Fonte', isDefault: false, stale: false, rows: [] });
    if (action === 'meta') return json({ meta: SERIES_META });
    return json({ score: null, failed: false });
  });
  // As capas do teste não existem
  await page.route('https://img.test/**', (route) => route.abort());
}

const playEpisodeOne = async (page: Page) => {
  await page.goto('/detail/series/tt2/tt2%3A1%3A1');
  await page.getByRole('button', { name: /Filme\.1080p\.H264\.mkv/ }).click();
  await submitName(page, 'Ana');
  await expect(page).toHaveURL(/\?room=[A-Z0-9]+/);
  await waitReady(page);
};
const seekAndPlay = (page: Page, seconds: number) =>
  video(page).evaluate(
    (v: HTMLVideoElement, t) => {
      v.muted = true;
      v.currentTime = t;
      void v.play();
    },
    seconds
  );
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('lunio_continue') || '[]'));

test.describe('Continuar assistindo', () => {
  test('guarda título, episódio e posição (sem o link), aparece no catálogo e o vídeo reabre onde parou', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await setup(page);
    await playEpisodeOne(page);
    await seekAndPlay(page, 40);
    await expect.poll(async () => (await stored(page))[0]?.position ?? 0, { timeout: 20_000 }).toBeGreaterThanOrEqual(35);

    const entry = (await stored(page))[0];
    expect(entry).toMatchObject({ type: 'series', id: 'tt2', name: 'Série Dois', videoId: 'tt2:1:1', season: 1, episode: 1 });
    expect(JSON.stringify(entry)).not.toContain('127.0.0.1:3101'); // nunca o link do stream

    await page.goto('/catalog');
    const row = page.getByRole('region', { name: 'Continuar assistindo' });
    await expect(row).toBeVisible();
    await expect(row.getByText('Série Dois')).toBeVisible();
    await expect(row.getByText('S01E01')).toBeVisible();
    await expect(row.getByRole('progressbar')).toBeVisible();

    // Clicar abre a página do episódio; escolher o stream de novo abre o vídeo no ponto em que parou
    await row.getByText('Série Dois').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/detail/series/tt2/tt2%3A1%3A1');
    await expect(page.getByText(/Retoma em \d{2}:\d{2}/)).toBeVisible(); // avisa antes de escolher o stream
    await page.getByRole('button', { name: /Filme\.1080p\.H264\.mkv/ }).click();
    await submitName(page, 'Ana');
    await expect(page).toHaveURL(/\?room=[A-Z0-9]+/);
    await waitReady(page);
    await expect.poll(async () => (await state(page)).t, { timeout: 30_000 }).toBeGreaterThanOrEqual(35);
    await page.close();
  });

  test('terminar o episódio põe o próximo na fileira, sem barra; o X tira o título', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await setup(page);
    await playEpisodeOne(page);
    await seekAndPlay(page, 30);
    await expect.poll(async () => (await stored(page))[0]?.position ?? 0, { timeout: 20_000 }).toBeGreaterThanOrEqual(25);
    // chega a mais de 95% do episódio
    const duration = await video(page).evaluate((v: HTMLVideoElement) => v.duration);
    await seekAndPlay(page, Math.floor(duration * 0.97));
    await expect.poll(async () => (await stored(page))[0]?.next ?? false, { timeout: 20_000 }).toBe(true);

    await page.goto('/catalog');
    const row = page.getByRole('region', { name: 'Continuar assistindo' });
    await expect(row.getByText('Próximo · S01E02')).toBeVisible();
    await expect(row.getByRole('progressbar')).toHaveCount(0);

    await row.getByText('Série Dois').hover();
    await row.getByRole('button', { name: 'Tirar de Continuar assistindo' }).click();
    await expect(page.getByRole('region', { name: 'Continuar assistindo' })).toHaveCount(0);
    expect(await stored(page)).toEqual([]);
    await page.close();
  });

  test('um vídeo colado (fora do catálogo) não entra na lista', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await setup(page);
    await page.goto('/');
    await page.getByRole('button', { name: /Colar link de stream/ }).click();
    await page.getByRole('textbox', { name: 'URL do stream' }).fill('http://127.0.0.1:3101/teste.mkv');
    await page.getByRole('button', { name: 'Criar sala' }).click();
    await submitName(page, 'Ana');
    await waitReady(page);
    await seekAndPlay(page, 40);
    await page.waitForTimeout(7000);
    expect(await stored(page)).toEqual([]);
    await page.close();
  });

  test('"Recomeçar do início" tira a retomada: o vídeo abre do zero e o título sai da fileira', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await setup(page);
    await playEpisodeOne(page);
    await seekAndPlay(page, 40);
    await expect.poll(async () => (await stored(page))[0]?.position ?? 0, { timeout: 20_000 }).toBeGreaterThanOrEqual(35);

    await page.goto('/detail/series/tt2/tt2%3A1%3A1');
    await expect(page.getByText(/Retoma em \d{2}:\d{2}/)).toBeVisible();
    await page.getByRole('button', { name: 'Recomeçar do início' }).click();
    await expect(page.getByText(/Retoma em/)).toHaveCount(0);
    expect(await stored(page)).toEqual([]);

    await page.getByRole('button', { name: /Filme\.1080p\.H264\.mkv/ }).click();
    await submitName(page, 'Ana');
    await expect(page).toHaveURL(/\?room=[A-Z0-9]+/);
    await waitReady(page);
    await page.waitForTimeout(1500);
    expect((await state(page)).t).toBeLessThan(10);
    await page.close();
  });
});
