import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** Vídeo servido pelo fixture (e2e/fixture-server.mjs): MKV de 2 min com 2 faixas de áudio. */
export const FIXTURE_URL = 'http://127.0.0.1:3101/teste.mkv';
/** Vídeo curto com áudio japonês/português e legendas ASS en (faixa 3) e pt (faixa 4). */
export const SUBTITLES_URL = 'http://127.0.0.1:3101/legendas.mkv';

export async function newUser(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on('dialog', (d) => void d.accept()); // confirmações de expulsar/banir
  return { context, page };
}

/** Preenche o apelido no modal "Como você quer ser chamado?" e confirma. */
export async function submitName(page: Page, name: string) {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Como você quer ser chamado?')).toBeVisible();
  await dialog.getByLabel('Seu apelido na sala').fill(name);
  await dialog.locator('form button[type="submit"]').click();
}

/** Home → "Colar link de stream" → Criar sala. Devolve o código da sala. */
export async function createRoom(page: Page, name: string, url = FIXTURE_URL): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: /Colar link de stream/ }).click();
  await page.getByRole('textbox', { name: 'URL do stream' }).fill(url);
  await page.getByRole('button', { name: 'Criar sala' }).click();
  await submitName(page, name);
  await expect(page).toHaveURL(/\?room=[A-Z0-9]+/);
  const code = new URL(page.url()).searchParams.get('room')!;
  await expect(page.locator('video')).toBeAttached();
  return code;
}

/** Abre o link da sala e entra com o apelido. */
export async function joinRoom(page: Page, code: string, name: string) {
  await page.goto(`/?room=${code}`);
  await submitName(page, name);
  await expect(page.locator('video')).toBeAttached();
}

export const video = (page: Page) => page.locator('video').first();

export const state = (page: Page) =>
  video(page).evaluate((v: HTMLVideoElement) => ({ paused: v.paused, t: v.currentTime, rs: v.readyState, ended: v.ended, src: v.currentSrc.replace(/([?&])t=[^&#]+/, '$1t=…') }));

/** Espera o vídeo ter dados suficientes para tocar. */
export async function waitReady(page: Page) {
  await expect.poll(async () => (await state(page)).rs, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
}

/** Atalhos do player (Espaço = play/pause) com o foco fora de campos de texto. */
export async function togglePlay(page: Page) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('k');
}

/** Abre o painel da sala na aba "Participantes" (onde ficam expulsar/banir). */
export async function openParticipants(page: Page) {
  const tab = page.getByRole('tab', { name: /Participantes/ });
  if (!(await tab.isVisible().catch(() => false))) await page.keyboard.press('w');
  await tab.click();
}
