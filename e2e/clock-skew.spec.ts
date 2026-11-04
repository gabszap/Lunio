import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createRoom, joinRoom, newUser, openParticipants, state, togglePlay, waitReady } from './helpers';

/** O Host leva o vídeo para perto de `seconds` (tecla L = +10 s) e dá play, pelos controles, que avisam a sala. */
async function hostPlaysFrom(page: Page, seconds: number) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < Math.round(seconds / 10); i++) await page.keyboard.press('l');
  await expect.poll(async () => (await state(page)).t, { timeout: 10_000 }).toBeGreaterThan(seconds - 5);
  await togglePlay(page);
}

test.describe('Relógio do computador', () => {
  // A sala carimba as posições com a hora do servidor. Quem tem o relógio errado (aqui 90 s atrasado) não pode
  // ficar 90 s fora do ponto do Host por isso.
  test('um relógio 90 s atrasado não atrasa o vídeo de quem assiste', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    await guest.page.addInitScript(() => {
      const real = Date.now.bind(Date);
      Date.now = () => real() - 90_000;
    });
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    await waitReady(guest.page);

    await hostPlaysFrom(host.page, 80);

    await expect.poll(async () => (await state(guest.page)).t, { timeout: 30_000 }).toBeGreaterThan(75);
    await expect
      .poll(async () => Math.abs((await state(host.page)).t - (await state(guest.page)).t), { timeout: 15_000, message: 'espectador perto do Host' })
      .toBeLessThan(3);
    await host.context.close();
    await guest.context.close();
  });

  test('o painel aponta quem informa estar atrasado, a partir de 2 s de diferença', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    // O player do espectador corrige o vídeo sozinho; para o servidor ver um atraso, o heartbeat dele diz 5 s
    await guest.page.addInitScript(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: string) {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'client:heartbeat') data = JSON.stringify({ ...msg, currentTime: 5 });
        } catch {
          // não é JSON
        }
        return send.call(this, data);
      };
    });
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    await waitReady(guest.page);
    await hostPlaysFrom(host.page, 60);

    await openParticipants(host.page);
    await expect(host.page.getByText(/Atrasado \d+:\d\d/)).toBeVisible({ timeout: 30_000 });
    await host.context.close();
    await guest.context.close();
  });
});
