import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createRoom, newUser, state, waitReady } from './helpers';

/** Abre o endereço e, se a sala pedir o apelido de novo (mesmo usuário, ID mantido), responde. */
async function open(page: Page, path: string) {
  await page.goto(path);
  const dialog = page.getByRole('dialog');
  // `isVisible` não espera: o diálogo aparece um instante depois de carregar a página
  if (await dialog.waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false)) {
    await dialog.getByLabel('Seu apelido na sala').fill('Ana');
    await dialog.locator('form button[type="submit"]').click();
  }
  await expect(page.locator('video')).toBeAttached();
}

test('link com ?t=: o Host abre o vídeo naquele instante, uma vez, e o endereço perde o ?t=', async ({ browser }) => {
  const host = await newUser(browser);
  const code = await createRoom(host.page, 'Ana');
  await waitReady(host.page);

  // O Host recarrega pelo link com o instante (o fixture tem 2 min)
  await open(host.page, `/?room=${code}&t=1m10s`);
  await waitReady(host.page);
  await expect.poll(async () => (await state(host.page)).t, { timeout: 30_000 }).toBeGreaterThan(69);
  expect((await state(host.page)).t).toBeLessThan(75);

  // Usou o ?t= e tirou do endereço: copiar o link ou recarregar não volta àquele ponto
  expect(new URL(host.page.url()).searchParams.has('t')).toBe(false);
  expect(new URL(host.page.url()).searchParams.get('room')).toBe(code);

  await host.context.close();
});

test('link com ?t= inválido é ignorado', async ({ browser }) => {
  const host = await newUser(browser);
  const code = await createRoom(host.page, 'Ana');
  await waitReady(host.page);

  await open(host.page, `/?room=${code}&t=abc`);
  await waitReady(host.page);
  expect((await state(host.page)).t).toBeLessThan(5);

  await host.context.close();
});

test('Compartilhar > "Link neste instante" copia o link da sala com o ?t= do ponto em que o vídeo está', async ({ browser }) => {
  const host = await newUser(browser);
  await host.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const code = await createRoom(host.page, 'Ana');
  await waitReady(host.page);

  await host.page.evaluate(() => {
    const v = document.querySelector('video')!;
    v.muted = true;
    v.currentTime = 50;
  });
  await expect.poll(async () => (await state(host.page)).t, { timeout: 20_000 }).toBeGreaterThan(49);

  await host.page.keyboard.press('w'); // abre o painel da sala
  await host.page.getByRole('button', { name: 'Compartilhar', expanded: false }).click();
  await host.page.getByRole('menuitem', { name: /Link neste instante/ }).click();
  await expect(host.page.getByRole('button', { name: 'Link copiado' })).toBeVisible();

  const link = new URL(await host.page.evaluate(() => navigator.clipboard.readText()));
  expect(link.searchParams.get('room')).toBe(code);
  const t = Number(link.searchParams.get('t'));
  expect(t).toBeGreaterThanOrEqual(49);
  expect(t).toBeLessThan(60);

  await host.context.close();
});
