import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, newUser, submitName, waitReady } from './helpers';

test.describe('Voltar à última sala', () => {
  test('sair para a Home mostra o cartão da sala e "Voltar" entra de novo nela', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser); // mantém a sala viva depois que o Host sai
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);

    await host.page.mouse.move(640, 360);
    await host.page.getByRole('button', { name: 'Voltar', exact: true }).click();
    await expect(host.page).not.toHaveURL(/room=/);

    const card = host.page.locator('section', { hasText: `Voltar à sala ${code}` });
    await expect(card).toBeVisible();
    await expect(card).toContainText('1 pessoa na sala');
    await expect(card).toContainText('Você saiu');

    await card.getByRole('button', { name: 'Voltar', exact: true }).click();
    await submitName(host.page, 'Ana');
    await expect(host.page).toHaveURL(new RegExp(`room=${code}`));
    await expect(host.page.locator('video')).toBeAttached();

    await host.context.close();
    await guest.context.close();
  });

  test('sala que não existe mais some do cartão e do navegador; "Esquecer" também limpa', async ({ browser }) => {
    const { context, page } = await newUser(browser);
    await page.goto('/home');
    await page.evaluate(() => localStorage.setItem('lunio_last_room', JSON.stringify({ code: 'NAOEXIST', at: Date.now() - 120_000 })));
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Crie uma sala' })).toBeVisible();
    await expect(page.getByText('Voltar à sala NAOEXIST')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('lunio_last_room'))).toBeNull();
    await context.close();
  });

  test('"Esquecer essa sala" tira o cartão e o registro', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');

    await host.page.goto('/home'); // volta à Home recarregando: o registro da sala já foi gravado ao entrar
    const card = host.page.locator('section', { hasText: `Voltar à sala ${code}` });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Esquecer essa sala' }).click();
    await expect(card).toHaveCount(0);
    expect(await host.page.evaluate(() => localStorage.getItem('lunio_last_room'))).toBeNull();

    await host.context.close();
    await guest.context.close();
  });
});
