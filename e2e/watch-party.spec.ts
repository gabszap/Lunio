import { test, expect } from '@playwright/test';
import { SUBTITLES_URL, createRoom, joinRoom, newUser, openParticipants, state, togglePlay, trackHls, video, waitReady } from './helpers';

test.describe('Watch Party', () => {
  test('fila: quando o vídeo acaba, o próximo começa sozinho para todos', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    await waitReady(guest.page);

    await host.page.getByLabel('Link para adicionar à fila').fill(SUBTITLES_URL);
    await host.page.getByRole('button', { name: 'Adicionar à fila' }).click();
    await expect(host.page.getByText('por Ana')).toBeVisible();

    // Leva o vídeo para 1 s do fim e deixa acabar
    await video(host.page).evaluate((v: HTMLVideoElement) => {
      v.muted = true;
      v.currentTime = Math.max(0, v.duration - 1);
      void v.play();
    });
    await expect.poll(async () => (await state(host.page)).src, { timeout: 40_000 }).toContain('legendas');
    await expect.poll(async () => (await state(guest.page)).src, { timeout: 40_000 }).toContain('legendas');
    await expect(host.page.getByText('A fila está vazia.')).toBeVisible();
    // e começa a tocar sem ninguém apertar play
    await expect.poll(async () => (await state(host.page)).paused, { timeout: 30_000 }).toBe(false);

    await host.context.close();
    await guest.context.close();
  });

  test('fila: o espectador adiciona, o Host toca agora e o vídeo troca para todos', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    await waitReady(guest.page);

    // Bia (espectador) adiciona um vídeo à fila (seção abaixo do player)
    await guest.page.getByLabel('Link para adicionar à fila').fill(SUBTITLES_URL);
    await guest.page.getByRole('button', { name: 'Adicionar à fila' }).click();
    await expect(guest.page.getByText('por Bia')).toBeVisible();

    // O Host vê o item, não vê o do outro como removível por engano e toca agora
    await expect(host.page.getByText('por Bia')).toBeVisible();
    await host.page.getByRole('button', { name: 'Tocar agora' }).click();

    // A fila esvazia nos dois e o vídeo trocou nos dois
    await expect(host.page.getByText('A fila está vazia.')).toBeVisible();
    await expect(guest.page.getByText('A fila está vazia.')).toBeVisible();
    await expect.poll(async () => (await state(host.page)).src, { timeout: 30_000 }).toContain('legendas');
    await expect.poll(async () => (await state(guest.page)).src, { timeout: 30_000 }).toContain('legendas');

    await host.context.close();
    await guest.context.close();
  });

  test('play, pause e seek do Host chegam ao espectador', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    await waitReady(guest.page);

    // play
    await togglePlay(host.page);
    await expect.poll(async () => (await state(host.page)).paused, { timeout: 15_000 }).toBe(false);
    await expect.poll(async () => (await state(guest.page)).paused, { timeout: 15_000 }).toBe(false);
    await expect.poll(async () => (await state(guest.page)).t, { timeout: 15_000 }).toBeGreaterThan(1);

    // sincronizados (a correção de drift mantém a diferença pequena)
    await expect
      .poll(async () => Math.abs((await state(host.page)).t - (await state(guest.page)).t), { timeout: 20_000 })
      .toBeLessThan(2);

    // pause
    await togglePlay(host.page);
    await expect.poll(async () => (await state(host.page)).paused).toBe(true);
    await expect.poll(async () => (await state(guest.page)).paused, { timeout: 15_000 }).toBe(true);

    // seek do Host (tecla L = +10 s) leva o espectador junto
    const before = (await state(host.page)).t;
    await host.page.keyboard.press('l');
    await expect.poll(async () => (await state(host.page)).t, { timeout: 10_000 }).toBeGreaterThan(before + 8);
    await expect
      .poll(async () => Math.abs((await state(host.page)).t - (await state(guest.page)).t), { timeout: 15_000 })
      .toBeLessThan(2);

    await host.context.close();
    await guest.context.close();
  });

  test('o espectador não controla a reprodução', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(guest.page);

    await togglePlay(guest.page); // tenta dar play
    await host.page.waitForTimeout(2500);
    expect((await state(host.page)).paused).toBe(true);
    expect((await state(guest.page)).paused).toBe(true);

    await host.context.close();
    await guest.context.close();
  });

  test('expulsar tira a pessoa da sala (pode voltar) e banir expulsa na hora', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');

    // kick
    await openParticipants(host.page);
    await host.page.getByRole('button', { name: 'Expulsar da sala' }).click();
    await expect(guest.page).not.toHaveURL(/room=/, { timeout: 15_000 });
    await expect(guest.page.locator('video')).toHaveCount(0);

    // volta
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(guest.page);

    // ban
    await openParticipants(host.page);
    await host.page.getByRole('button', { name: 'Banir da sala' }).click();
    await expect(guest.page).not.toHaveURL(/room=/, { timeout: 15_000 });

    // o Host vê a pessoa na lista de banidos e pode desbanir
    await openParticipants(host.page);
    await expect(host.page.getByRole('button', { name: 'Desbanir' })).toBeVisible();

    await host.context.close();
    await guest.context.close();
  });
});

// Hoje o ID do usuário é por aba (sessionStorage): quem foi banido volta abrindo uma aba nova.
// O servidor já recusa o ID banido (testes unitários); falta o ID persistente da Fase 8.1 do plano.
test.fixme('banido não consegue voltar abrindo o link de novo (depende do ID persistente, Fase 8.1)', async ({ browser }) => {
  const host = await newUser(browser);
  const guest = await newUser(browser);
  const code = await createRoom(host.page, 'Ana');
  await joinRoom(guest.page, code, 'Bia');
  await openParticipants(host.page);
  await host.page.getByRole('button', { name: 'Banir da sala' }).click();
  await expect(guest.page).not.toHaveURL(/room=/, { timeout: 15_000 });
  await guest.page.goto(`/?room=${code}`);
  const dialog = guest.page.getByRole('dialog');
  if (await dialog.isVisible({ timeout: 3000 }).catch(() => false)) await dialog.locator('form button[type="submit"]').click();
  await expect(guest.page.getByText(/banid/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(guest.page.locator('video')).toHaveCount(0);
});

test.describe('Player', () => {
  const pickPortugueseAudio = async (page: import('@playwright/test').Page) => {
    await page.getByRole('button', { name: 'Faixas de áudio' }).click();
    await page.getByRole('menuitemradio', { name: /Português/ }).click();
  };

  test('com áudio alternativo, pausar e dar play não volta ao começo do trecho', async ({ browser }) => {
    const host = await newUser(browser);
    const hls = trackHls(host.page);
    await createRoom(host.page, 'Ana');
    await waitReady(host.page);

    // troca para a segunda faixa de áudio (HLS compartilhado: o vídeo é MKV H.264 com Cues)
    await pickPortugueseAudio(host.page);
    await expect.poll(() => hls.playlist(), { timeout: 20_000 }).toMatch(/\/api\/hls\/[a-f0-9]+\/\d+\/index\.m3u8/);

    await togglePlay(host.page);
    await expect.poll(async () => (await state(host.page)).t, { timeout: 30_000 }).toBeGreaterThan(4);

    await togglePlay(host.page);
    await expect.poll(async () => (await state(host.page)).paused).toBe(true);
    const pausedAt = (await state(host.page)).t;
    await host.page.waitForTimeout(1500);
    await togglePlay(host.page);
    await expect.poll(async () => (await state(host.page)).paused, { timeout: 15_000 }).toBe(false);
    await host.page.waitForTimeout(3000);

    const after = await state(host.page);
    // antes do conserto, o play depois do pause reiniciava do 00:00 do trecho remuxado
    expect(after.t).toBeGreaterThan(pausedAt - 0.5);
    expect(after.t).toBeGreaterThan(pausedAt + 1);
    await host.context.close();
  });

  test('com áudio alternativo por HLS, o seek é rápido e o tempo é absoluto', async ({ browser }) => {
    const host = await newUser(browser);
    const hls = trackHls(host.page);
    await createRoom(host.page, 'Ana');
    await waitReady(host.page);
    await pickPortugueseAudio(host.page);
    await expect.poll(() => hls.playlist(), { timeout: 20_000 }).toMatch(/index\.m3u8/);

    await togglePlay(host.page);
    await expect.poll(async () => (await state(host.page)).t, { timeout: 30_000 }).toBeGreaterThan(3);

    // pula ~50 s à frente (muito além do que já foi baixado): com o remux isso reiniciava o FFmpeg (3–5 s)
    const before = (await state(host.page)).t;
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await host.page.keyboard.press('l'); // 5 × 10 s
    await expect
      .poll(async () => {
        const s = await state(host.page);
        return s.t > before + 45 && s.rs >= 3 && !s.paused;
      }, { timeout: 20_000, intervals: [100] })
      .toBe(true);
    const took = Date.now() - t0;
    // linha do tempo absoluta: depois do pulo o relógio do vídeo está em ~55 s, não perto de 0 (como no remux com offset)
    expect((await state(host.page)).t).toBeGreaterThan(before + 45);
    expect(took).toBeLessThan(8000);
    await host.context.close();
  });

  test('quem está na sala usa a mesma playlist: o áudio é gerado uma vez para todos', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    const hostHls = trackHls(host.page);
    const guestHls = trackHls(guest.page);
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    await waitReady(guest.page);

    await pickPortugueseAudio(host.page);
    await pickPortugueseAudio(guest.page);
    await expect.poll(() => hostHls.playlist(), { timeout: 20_000 }).toMatch(/index\.m3u8/);
    await expect.poll(() => guestHls.playlist(), { timeout: 20_000 }).toMatch(/index\.m3u8/);
    expect(hostHls.playlist()).toBe(guestHls.playlist());

    // e o Host controla os dois: play chega ao convidado mesmo com cada um no seu áudio
    await togglePlay(host.page);
    await expect.poll(async () => (await state(guest.page)).paused, { timeout: 25_000 }).toBe(false);
    await host.context.close();
    await guest.context.close();
  });

  test('se o HLS não estiver disponível, o áudio alternativo cai no remux e toca do mesmo jeito', async ({ browser }) => {
    const host = await newUser(browser);
    await host.page.route('**/api/hls/start', (route) =>
      route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'no_keyframes' }) })
    );
    await createRoom(host.page, 'Ana');
    await waitReady(host.page);
    await pickPortugueseAudio(host.page);
    await expect.poll(async () => (await state(host.page)).src, { timeout: 20_000 }).toMatch(/audio=/);
    await togglePlay(host.page);
    await expect.poll(async () => (await state(host.page)).t, { timeout: 30_000 }).toBeGreaterThan(3);
    await host.context.close();
  });

  test('o Host que recarrega a página retoma a posição da sala', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);

    await togglePlay(host.page);
    await host.page.keyboard.press('l'); // +10 s
    await expect.poll(async () => (await state(host.page)).t, { timeout: 20_000 }).toBeGreaterThan(12);
    await togglePlay(host.page); // pausa
    await expect.poll(async () => (await state(host.page)).paused).toBe(true);
    const pausedAt = (await state(host.page)).t;

    await host.page.reload();
    // volta como o mesmo usuário (ID mantido no reload): pode pedir o apelido de novo
    const dialog = host.page.getByRole('dialog');
    if (await dialog.isVisible({ timeout: 4000 }).catch(() => false)) {
      await dialog.getByLabel('Seu apelido na sala').fill('Ana');
      await dialog.locator('form button[type="submit"]').click();
    }
    await expect(host.page.locator('video')).toBeAttached();
    await waitReady(host.page);
    await expect.poll(async () => (await state(host.page)).t, { timeout: 20_000 }).toBeGreaterThan(pausedAt - 3);
    // a sala (e o espectador) continuam na mesma posição
    expect(Math.abs((await state(guest.page)).t - pausedAt)).toBeLessThan(3);

    await host.context.close();
    await guest.context.close();
  });
});
