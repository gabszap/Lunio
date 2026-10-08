import { test, expect, type Page } from '@playwright/test';
import { SUBTITLES_URL, createRoom, joinRoom, newUser, state, waitReady } from './helpers';

/** Registra os pedidos de legenda e faz o `track` indicado falhar (como um PGS ou uma extração impossível). */
async function failTracks(page: Page, failing: number[]) {
  const requested: number[] = [];
  await page.route(/\/api\/subtitle\?/, async (route) => {
    const track = Number(new URL(route.request().url()).searchParams.get('track'));
    requested.push(track);
    if (failing.includes(track)) {
      await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'EXTRACTION_FAILED' }) });
    } else {
      await route.continue();
    }
  });
  return requested;
}

const failurePrompt = (page: Page) => page.locator('#subtitle-failure-prompt');

test.describe('Legendas', () => {
  test('legenda obrigatória que falha: "Tentar a próxima" segue o ranking (PT antes de EN)', async ({ browser }) => {
    const { page, context } = await newUser(browser);
    const requested = await failTracks(page, [4]); // a PT-BR (melhor do ranking) falha
    await createRoom(page, 'Ana', SUBTITLES_URL);

    await expect(failurePrompt(page)).toBeVisible({ timeout: 30_000 });
    await expect(failurePrompt(page)).toContainText('EXTRACTION_FAILED');
    expect(requested[0]).toBe(4); // começou pela melhor do ranking, não pela primeira do arquivo (3)

    await failurePrompt(page).getByRole('button', { name: 'Tentar a próxima' }).click();
    await expect(failurePrompt(page)).toBeHidden({ timeout: 20_000 });
    expect(requested).toContain(3);

    await waitReady(page);
    await context.close();
  });

  test('todas falham: sem "Tentar a próxima"; "Assistir sem legenda" libera o vídeo', async ({ browser }) => {
    const { page, context } = await newUser(browser);
    await failTracks(page, [3, 4]);
    await createRoom(page, 'Ana', SUBTITLES_URL);

    await expect(failurePrompt(page)).toBeVisible({ timeout: 30_000 });
    await failurePrompt(page).getByRole('button', { name: 'Tentar a próxima' }).click();
    // a segunda também falhou: acabaram as candidatas
    await expect(failurePrompt(page)).toBeVisible();
    await expect(failurePrompt(page).getByRole('button', { name: 'Tentar a próxima' })).toHaveCount(0);

    await failurePrompt(page).getByRole('button', { name: 'Assistir sem legenda' }).click();
    await expect(failurePrompt(page)).toBeHidden();
    await waitReady(page);
    await context.close();
  });

  test('a escolha de legenda é local: o convidado não é afetado pelo que o Host escolhe', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    const code = await createRoom(host.page, 'Ana', SUBTITLES_URL);
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    await waitReady(guest.page);
    await expect(failurePrompt(host.page)).toHaveCount(0);

    const menu = (page: Page) => page.getByRole('button', { name: 'Faixas de legenda' }).or(page.getByRole('button', { name: /Legendas/ })).first();
    const selected = async (page: Page) => {
      await menu(page).click();
      const label = await page.getByRole('menuitemradio', { checked: true }).first().innerText();
      await page.keyboard.press('Escape');
      return label;
    };

    // o ranking escolheu a PT nos dois
    expect(await selected(host.page)).toMatch(/Português/);
    expect(await selected(guest.page)).toMatch(/Português/);

    // o Host troca para a EN
    await menu(host.page).click();
    await host.page.getByRole('menuitemradio', { name: /Inglês/ }).click();
    await host.page.waitForTimeout(1500);
    expect(await selected(host.page)).toMatch(/Inglês/);
    expect(await selected(guest.page)).toMatch(/Português/);

    await host.context.close();
    await guest.context.close();
  });
});
