import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_URL, SUBTITLES_URL, createRoom, joinRoom, newUser, state, video, waitReady } from './helpers';

/** Tudo o que a página recebeu ou pediu: pedidos HTTP (URL e corpo) e quadros do WebSocket. */
function spy(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => seen.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`));
  page.on('websocket', (ws) => ws.on('framereceived', (f) => seen.push(`ws< ${String(f.payload)}`)));
  return { seen, leaked: (secret: string) => seen.filter((s) => s.includes(secret) || s.includes(encodeURIComponent(secret))) };
}

test.describe('links opacos', () => {
  test('o espectador nunca vê o link do Host (rede nem WebSocket) e o vídeo toca igual', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    const secretUrl = `${FIXTURE_URL}?token=CHAVE-E2E-DO-HOST`;
    const spyGuest = spy(guest.page);
    const spyHost = spy(host.page);

    const code = await createRoom(host.page, 'Ana', secretUrl);
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    await waitReady(guest.page);

    // O Host segue vendo o próprio link; o espectador só o id, e o vídeo carregou pelo proxy com ele
    expect((await state(host.page)).src).toContain(encodeURIComponent(secretUrl));
    expect((await state(guest.page)).src).toMatch(/url=lk_[\w-]{22}/);
    expect(spyHost.leaked('CHAVE-E2E-DO-HOST').length).toBeGreaterThan(0);
    expect(spyGuest.leaked('CHAVE-E2E-DO-HOST')).toEqual([]);

    // Trilhas, legendas e tudo mais que pede `?url=` também funcionam com o id (o espectador abre o menu de áudio)
    await expect(guest.page.getByRole('button', { name: 'Faixas de áudio' })).toBeVisible({ timeout: 30_000 });
    expect(spyGuest.leaked('CHAVE-E2E-DO-HOST')).toEqual([]);

    await host.context.close();
    await guest.context.close();
  });

  test('fila: o link que o Host adiciona chega ao espectador só como id, e o item toca para os dois', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    const queued = `${SUBTITLES_URL}?token=CHAVE-E2E-DA-FILA`;
    const spyGuest = spy(guest.page);

    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    await waitReady(guest.page);

    await host.page.getByLabel('Link para adicionar à fila').fill(queued);
    await host.page.getByRole('button', { name: 'Adicionar à fila' }).click();
    await expect(host.page.getByText('por Ana')).toBeVisible();

    await video(host.page).evaluate((v: HTMLVideoElement) => {
      v.muted = true;
      v.currentTime = Math.max(0, v.duration - 1);
      void v.play();
    });
    await expect.poll(async () => (await state(host.page)).src, { timeout: 40_000 }).toContain('legendas');
    await expect.poll(async () => (await state(guest.page)).src, { timeout: 40_000 }).toMatch(/url=lk_[\w-]{22}/);
    await waitReady(guest.page);
    expect(spyGuest.leaked('CHAVE-E2E-DA-FILA')).toEqual([]);

    await host.context.close();
    await guest.context.close();
  });
});
