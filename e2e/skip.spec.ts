import { test, expect } from '@playwright/test';
import { CHAPTERS_URL, createRoom, joinRoom, newUser, state, togglePlay, waitReady } from './helpers';

/** Leva o vídeo do Host (sozinho na sala) para o segundo `at` e toca. */
async function seekTo(page: import('@playwright/test').Page, at: number) {
  await page.evaluate((to) => {
    const v = document.querySelector('video')!;
    v.muted = true;
    v.currentTime = to;
    void v.play();
  }, at);
  await expect.poll(async () => (await state(page)).t, { timeout: 20_000 }).toBeGreaterThan(at - 0.5);
}
const seekIntoOpening = (page: import('@playwright/test').Page) => seekTo(page, 7);

/** Pelos controles do Host (que a sala acompanha): dá play, avança 10 s (cai dentro da abertura) e pausa. */
async function hostIntoOpeningPaused(page: import('@playwright/test').Page) {
  await togglePlay(page);
  await page.keyboard.press('l');
  await expect.poll(async () => (await state(page)).t, { timeout: 20_000 }).toBeGreaterThan(9.5);
  await togglePlay(page);
  await expect.poll(async () => (await state(page)).paused).toBe(true);
}

test.describe('Pular abertura', () => {
  test('pular sozinho: com a opção ligada, o Host entra na abertura e o vídeo vai para o fim dela', async ({ browser }) => {
    const host = await newUser(browser);
    await host.context.addInitScript(() => localStorage.setItem('lunio_auto_skip_intro', '1'));
    await createRoom(host.page, 'Ana', CHAPTERS_URL);
    await waitReady(host.page);

    await seekIntoOpening(host.page);
    // contagem de 5 s no botão; ninguém cancelou, então pula
    await expect(host.page.locator('#skip-chapter-prompt')).toContainText('qualquer tecla cancela');
    expect((await state(host.page)).t).toBeLessThan(15);
    await expect.poll(async () => (await state(host.page)).t, { timeout: 20_000 }).toBeGreaterThanOrEqual(15);

    await host.context.close();
  });

  test('qualquer tecla cancela o pulo automático (e ele não volta a disparar naquele capítulo)', async ({ browser }) => {
    const host = await newUser(browser);
    await host.context.addInitScript(() => localStorage.setItem('lunio_auto_skip_intro', '1'));
    await createRoom(host.page, 'Ana', CHAPTERS_URL);
    await waitReady(host.page);

    await seekIntoOpening(host.page);
    await expect(host.page.locator('#skip-chapter-prompt')).toContainText('qualquer tecla cancela');
    await host.page.keyboard.press('ArrowDown'); // qualquer tecla (aqui, volume)
    await expect(host.page.locator('#skip-chapter-prompt')).not.toContainText('qualquer tecla cancela');
    await host.page.waitForTimeout(7000); // passa dos 5 s da contagem
    expect((await state(host.page)).t).toBeLessThan(15);

    await host.context.close();
  });

  test('o encerramento também é pulado sozinho: vai para o fim do capítulo', async ({ browser }) => {
    const host = await newUser(browser);
    await host.context.addInitScript(() => localStorage.setItem('lunio_auto_skip_intro', '1'));
    await createRoom(host.page, 'Ana', CHAPTERS_URL);
    await waitReady(host.page);

    await seekTo(host.page, 36); // dentro do ED (35-40 s)
    await expect(host.page.locator('#skip-chapter-prompt')).toContainText('qualquer tecla cancela');
    await expect.poll(async () => (await state(host.page)).t, { timeout: 20_000 }).toBeGreaterThanOrEqual(39.5);

    await host.context.close();
  });

  test('Tab pula a abertura na hora (Host)', async ({ browser }) => {
    const host = await newUser(browser);
    await createRoom(host.page, 'Ana', CHAPTERS_URL);
    await waitReady(host.page);

    await seekIntoOpening(host.page);
    await host.page.locator('body').click({ position: { x: 5, y: 5 } });
    await host.page.keyboard.press('Tab');
    await expect.poll(async () => (await state(host.page)).t, { timeout: 20_000 }).toBeGreaterThanOrEqual(15);

    await host.context.close();
  });

  test('sem a opção ligada o vídeo fica na abertura e aparece o botão "Pular abertura" para o Host', async ({ browser }) => {
    const host = await newUser(browser);
    await createRoom(host.page, 'Ana', CHAPTERS_URL);
    await waitReady(host.page);

    await seekIntoOpening(host.page);
    await host.page.waitForTimeout(1500);
    expect((await state(host.page)).t).toBeLessThan(15);
    await host.page.locator('#skip-chapter-prompt').click();
    await expect.poll(async () => (await state(host.page)).t, { timeout: 20_000 }).toBeGreaterThanOrEqual(15);

    await host.context.close();
  });

  test('votação: com 3 pessoas, o segundo voto de espectador (botão ou Tab) faz a sala pular a abertura', async ({ browser }) => {
    const host = await newUser(browser);
    const bia = await newUser(browser);
    const caio = await newUser(browser);
    const code = await createRoom(host.page, 'Ana', CHAPTERS_URL);
    await joinRoom(bia.page, code, 'Bia');
    await joinRoom(caio.page, code, 'Caio');
    for (const u of [host, bia, caio]) await waitReady(u.page);

    await hostIntoOpeningPaused(host.page);
    const biaButton = bia.page.locator('#skip-chapter-prompt');
    const caioButton = caio.page.locator('#skip-chapter-prompt');
    await expect(biaButton).toBeVisible({ timeout: 20_000 });
    await expect(caioButton).toBeVisible({ timeout: 20_000 });
    await expect(biaButton).toContainText('Votar');

    // Bia vota: 1 de 2 necessários (3 pessoas), ninguém pula ainda e todos veem a contagem
    await biaButton.click();
    await expect(biaButton).toContainText('Voto enviado');
    await expect(biaButton).toContainText('1/2');
    await expect(caioButton).toContainText('1/2');
    await expect(host.page.locator('#skip-chapter-prompt')).toContainText('1/2');
    expect((await state(host.page)).t).toBeLessThan(15);

    // Caio vota: passou da metade, o Host pula e a sala o segue
    await caio.page.locator('body').click({ position: { x: 5, y: 5 } });
    await caio.page.keyboard.press('Tab'); // Tab também vota (ou pula, para o Host)
    await expect.poll(async () => (await state(host.page)).t, { timeout: 20_000 }).toBeGreaterThanOrEqual(15);
    await expect.poll(async () => (await state(bia.page)).t, { timeout: 20_000 }).toBeGreaterThanOrEqual(14);
    await expect.poll(async () => (await state(caio.page)).t, { timeout: 20_000 }).toBeGreaterThanOrEqual(14);

    await host.context.close();
    await bia.context.close();
    await caio.context.close();
  });
});
