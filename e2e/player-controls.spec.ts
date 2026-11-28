import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_URL, SUBTITLES_URL, createRoom, newUser, togglePlay, waitReady } from './helpers';

async function measureJassubInk(page: Page) {
  const canvas = page.locator('canvas.JASSUB');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  // Oculta o <video> e a camada de controles só durante o snapshot para isolar os pixels da legenda no canvas ASS
  await page.evaluate(() => {
    const v = document.querySelector('#video-player-root video') as HTMLElement | null;
    const ui = document.querySelector('#player-ui-overlay') as HTMLElement | null;
    if (v) v.style.opacity = '0';
    if (ui) ui.style.visibility = 'hidden';
  });
  let png: Buffer;
  try {
    png = await canvas.screenshot();
  } finally {
    await page.evaluate(() => {
      const v = document.querySelector('#video-player-root video') as HTMLElement | null;
      const ui = document.querySelector('#player-ui-overlay') as HTMLElement | null;
      if (v) v.style.opacity = '';
      if (ui) ui.style.visibility = '';
    });
  }
  const b64 = png.toString('base64');
  return page.evaluate(async (base64) => {
    const res = await fetch(`data:image/png;base64,${base64}`);
    const bmp = await createImageBitmap(await res.blob());
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    let inkPixels = 0;
    let minY = height;
    let maxY = -1;
    let sumY = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i] > 180 && data[i + 1] > 180 && data[i + 2] > 180) {
          inkPixels++;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          sumY += y;
        }
      }
    }
    return {
      width,
      height,
      inkPixels,
      bboxHeight: maxY >= minY ? maxY - minY + 1 : 0,
      meanY: inkPixels > 0 ? sumY / inkPixels : -1,
    };
  }, b64);
}

test('legenda ASS ao vivo: tamanho da fonte, altura, sincronia e layout dos botões funcionam no navegador', async ({ browser }) => {
  const { page, context } = await newUser(browser);
  try {
    await createRoom(page, 'Ana', SUBTITLES_URL);
    await waitReady(page);
    await expect(page.locator('canvas.JASSUB')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('status').filter({ hasText: /legenda|fontes|renderizador/i })).toBeHidden({ timeout: 30_000 });

    // Posiciona em t = 2s (dentro da fala 0.5s..15.0s) e deixa JASSUB renderizar um frame
    await togglePlay(page);
    await page.locator('video').evaluate((v: HTMLVideoElement) => {
      v.currentTime = 2.0;
    });
    await page.waitForTimeout(400);
    await togglePlay(page);
    await page.waitForTimeout(250);

    const base = await measureJassubInk(page);
    expect(base.inkPixels).toBeGreaterThan(200);
    expect(base.bboxHeight).toBeGreaterThan(8);

    // Abre menu unificado de Legendas e confere que nenhum chip de Sincronia está espremido/cortado
    await page.mouse.move(640, 360);
    await page.locator('#btn-subtitles-toggle').click();
    const menu = page.locator('#subtitles-popover-menu');
    await expect(menu).toBeVisible();

    const syncButtons = menu.locator('button').filter({ hasText: /ms|Redefinir/ });
    await expect(syncButtons).toHaveCount(5);
    const chipMetrics = await syncButtons.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          text: el.textContent?.trim() || '',
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          left: r.left,
          right: r.right,
        };
      })
    );
    for (let i = 0; i < chipMetrics.length; i++) {
      expect(chipMetrics[i].scrollWidth).toBeLessThanOrEqual(chipMetrics[i].clientWidth + 1);
      if (i > 0) {
        expect(chipMetrics[i].left).toBeGreaterThanOrEqual(chipMetrics[i - 1].right - 0.5);
      }
    }

    // 1) Aumenta tamanho da fonte para 175% -> legenda precisa crescer visivelmente no canvas ASS ao vivo
    await menu.getByRole('button', { name: '175%', exact: true }).click();
    await expect.poll(async () => (await measureJassubInk(page)).bboxHeight, { timeout: 10_000 }).toBeGreaterThan(base.bboxHeight * 1.35);
    const big = await measureJassubInk(page);
    expect(big.inkPixels).toBeGreaterThan(base.inkPixels * 1.5);

    // Volta para 100%
    await menu.getByRole('button', { name: '100%', exact: true }).click();
    await expect.poll(async () => (await measureJassubInk(page)).bboxHeight, { timeout: 10_000 }).toBeLessThan(big.bboxHeight * 0.85);

    // 2) Sobe altura da legenda para 20% -> centro vertical (meanY) precisa subir (Y menor)
    await menu.getByRole('button', { name: '20%', exact: true }).click();
    await expect.poll(async () => (await measureJassubInk(page)).meanY, { timeout: 10_000 }).toBeLessThan(base.meanY - 25);

    // Volta altura para 5%
    await menu.getByRole('button', { name: '5%', exact: true }).click();
    await expect.poll(async () => (await measureJassubInk(page)).meanY, { timeout: 10_000 }).toBeGreaterThan(base.meanY - 15);

    // 3) Sincronia da legenda: em t = 0.35s a fala (0.50s..15.0s) ainda não começou -> ink = 0.
    // Adiantando -250ms, ela passa a começar em 0.25s -> ink > 200!
    await page.locator('video').evaluate((v: HTMLVideoElement) => {
      v.currentTime = 0.35;
    });
    await page.waitForTimeout(250);
    await menu.getByRole('button', { name: 'Redefinir', exact: true }).click();
    await expect.poll(async () => (await measureJassubInk(page)).inkPixels, { timeout: 10_000 }).toBeLessThan(20);

    await menu.getByRole('button', { name: '−250 ms', exact: true }).click();
    await expect.poll(async () => (await measureJassubInk(page)).inkPixels, { timeout: 10_000 }).toBeGreaterThan(200);

    // Voltando para Redefinir (0 ms), desaparece de novo
    await menu.getByRole('button', { name: 'Redefinir', exact: true }).click();
    await expect.poll(async () => (await measureJassubInk(page)).inkPixels, { timeout: 10_000 }).toBeLessThan(20);
  } finally {
    await context.close();
  }
});

test('volume boost e atraso do áudio conectam Web Audio real e atualizam GainNode e DelayNode', async ({ browser }) => {
  const { page, context } = await newUser(browser);
  await page.addInitScript(() => {
    const spy = { contexts: [] as any[], mediaSources: 0, gainValues: [] as number[], delayValues: [] as number[] };
    (window as any).__audioSpy = spy;
    const OrigCtx = window.AudioContext;
    class SpyAudioContext extends OrigCtx {
      constructor(...args: any[]) {
        super(...args);
        spy.contexts.push(this);
      }
      createMediaElementSource(el: HTMLMediaElement) {
        spy.mediaSources++;
        return super.createMediaElementSource(el);
      }
      createGain() {
        const node = super.createGain();
        const origSet = node.gain.setValueAtTime.bind(node.gain);
        node.gain.setValueAtTime = (value: number, startTime: number) => {
          spy.gainValues.push(value);
          return origSet(value, startTime);
        };
        return node;
      }
      createDelay(maxDelayTime?: number) {
        const node = super.createDelay(maxDelayTime);
        const origSet = node.delayTime.setValueAtTime.bind(node.delayTime);
        node.delayTime.setValueAtTime = (value: number, startTime: number) => {
          spy.delayValues.push(value);
          return origSet(value, startTime);
        };
        return node;
      }
    }
    (window as any).AudioContext = SpyAudioContext;
  });

  try {
    await createRoom(page, 'Ana', FIXTURE_URL);
    await waitReady(page);
    await togglePlay(page);
    await page.waitForTimeout(300);

    await page.mouse.move(640, 360);
    await page.locator('#btn-settings-toggle').click();
    const panel = page.locator('#settings-popover-panel');
    await expect(panel).toBeVisible();
    const playerBox = await page.locator('#video-player-root').boundingBox();
    const panelBox = await panel.boundingBox();
    expect(playerBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(playerBox!.x + playerBox!.width + 1);
    expect(panelBox!.x).toBeGreaterThanOrEqual(playerBox!.x - 1);

    // Ativa Volume boost 200% e Atraso do áudio +250 ms
    await panel.getByRole('button', { name: '200%', exact: true }).click();
    await panel.getByRole('button', { name: '+250 ms', exact: true }).click();

    await expect.poll(async () =>
      page.evaluate(() => {
        const s = (window as any).__audioSpy;
        return {
          mediaSources: s.mediaSources,
          state: s.contexts[0]?.state ?? null,
          lastGain: s.gainValues[s.gainValues.length - 1] ?? null,
          lastDelay: s.delayValues[s.delayValues.length - 1] ?? null,
        };
      })
    ).toEqual({
      mediaSources: 1,
      state: 'running',
      lastGain: 2,
      lastDelay: 0.25,
    });
  } finally {
    await context.close();
  }
});

test('abas da Home e da barra lateral da sala animam indicador deslizante e troca de menus', async ({ browser }) => {
  const { page, context } = await newUser(browser);
  try {
    await page.goto('/');
    const indicator = page.locator('.lu-pill-indicator').first();
    await expect(indicator).toBeVisible();

    const clipInitialHome = await indicator.evaluate((el) => getComputedStyle(el).clipPath);
    expect(clipInitialHome).toContain('inset(');

    // Home abre em "Início": Início (0) → Status (2, direita) → Catálogo (1, esquerda) → Início (0, esquerda)
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('tab', { name: 'Status' }).click();
    await expect.poll(() => indicator.evaluate((el) => getComputedStyle(el).clipPath)).not.toBe(clipInitialHome);
    await expect(indicator).toHaveCSS('transition-property', /clip-path/);
    await expect(page.locator('main')).toHaveClass(/lu-tab-panel-right/);
    await expect(page.locator('main')).toHaveCSS('animation-name', 'lu-tab-enter-right');

    // Respeita prefers-reduced-motion: reduce (desativa animações espaciais)
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('main')).toHaveCSS('animation-name', 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await page.getByRole('tab', { name: 'Catálogo' }).click();
    await expect(page.locator('main')).toHaveClass(/lu-tab-panel-left/);
    await expect(page.locator('main')).toHaveCSS('animation-name', 'lu-tab-enter-left');
    await expect(page.getByRole('button', { name: 'Explorar', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Addons', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Calendário', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Biblioteca', exact: true })).toHaveCount(0);

    // Modal Addons deve abrir centralizado na viewport via portal (nunca preso ao <main>)
    await page.getByRole('button', { name: 'Addons', exact: true }).click();
    const addonsDialog = page.getByRole('dialog', { name: 'Addons' });
    await expect(addonsDialog).toBeVisible();
    const addonsBox = await addonsDialog.boundingBox();
    expect(addonsBox).not.toBeNull();
    expect(addonsBox!.y).toBeGreaterThanOrEqual(0);
    expect(addonsBox!.y + addonsBox!.height).toBeLessThanOrEqual(720);
    await page.keyboard.press('Escape');
    await expect(addonsDialog).toBeHidden();

    // Explorar / Ver tudo -> Voltar anima o retorno da esquerda
    await page.getByRole('button', { name: 'Explorar', exact: true }).click();
    await expect(page.locator('.lu-tab-panel-right').first()).toBeVisible();
    await page.getByRole('button', { name: 'Catálogo', exact: true }).click();
    await expect(page.locator('.lu-tab-panel-left').first()).toBeVisible();

    await page.getByRole('tab', { name: 'Início' }).click();
    await expect(page.locator('main')).toHaveClass(/lu-tab-panel-left/);

    // Alternador Criar sala / Entrar com código na nova Home
    await page.getByRole('tab', { name: 'Entrar com código' }).click();
    await expect(page.getByLabel('Link ou código da sala')).toBeVisible();
    await page.getByRole('tab', { name: 'Criar sala' }).click();
    await expect(page.getByLabel('Nome da sala')).toBeVisible();

    // Sala: indicador deslizante + transição direcional nas abas da barra lateral + campo de URL alinhado aos 360px do chat
    await createRoom(page, 'Ana', FIXTURE_URL);
    const sidebar = page.locator('aside[aria-label="Watch Party"]');
    const sidebarIndicator = sidebar.locator('.lu-pill-indicator').first();
    await expect(sidebarIndicator).toBeVisible();

    const urlBox = await page.getByRole('textbox', { name: 'Link para adicionar à fila' }).boundingBox();
    const sidebarBox = await sidebar.boundingBox();
    expect(urlBox).not.toBeNull();
    expect(sidebarBox).not.toBeNull();
    expect(Math.abs((urlBox?.width ?? 0) - (sidebarBox?.width ?? 0))).toBeLessThanOrEqual(4);

    const clipInitial = await sidebarIndicator.evaluate((el) => getComputedStyle(el).clipPath);
    expect(clipInitial).toContain('inset(');

    await sidebar.getByRole('tab', { name: /Membros/ }).click();
    await expect.poll(() => sidebarIndicator.evaluate((el) => getComputedStyle(el).clipPath)).not.toBe(clipInitial);
    await expect(sidebar.locator('.lu-tab-panel-right')).toBeVisible();

    await sidebar.getByRole('tab', { name: /Pedidos/ }).click();
    await expect(sidebar.locator('.lu-tab-panel-left')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('modal de senha mantém o foco ao digitar e permite entrar em sala privada', async ({ browser }) => {
  const host = await newUser(browser);
  const guest = await newUser(browser);
  try {
    const code = await createRoom(host.page, 'Ana', FIXTURE_URL);

    // Host configura sala privada com senha
    const hostSidebar = host.page.locator('aside[aria-label="Watch Party"]');
    await hostSidebar.getByRole('tab', { name: /Membros/ }).click();
    await hostSidebar.getByRole('button', { name: 'Configurar sala' }).click();
    await hostSidebar.getByRole('tab', { name: 'Privada' }).click();
    await hostSidebar.locator('#room-settings-password').fill('segredo42');
    await hostSidebar.getByRole('button', { name: 'Salvar' }).click();
    await expect(hostSidebar.getByText('Salvo')).toBeVisible();
    await expect(hostSidebar.getByRole('button', { name: 'Remover senha' })).toBeVisible();

    // Convidado entra pelo link direto /room/:code e digita a senha caractere a caractere (não pode perder foco pro X)
    await guest.page.goto(`/room/${code}`);
    const nameDialog = guest.page.getByRole('dialog', { name: 'Escolha seu apelido' });
    await expect(nameDialog).toBeVisible();
    await nameDialog.getByRole('textbox').fill('Bia');
    await nameDialog.getByRole('button', { name: 'Entrar na sala' }).click();

    const pwDialog = guest.page.getByRole('dialog', { name: 'Sala privada' });
    await expect(pwDialog).toBeVisible();
    const pwInput = pwDialog.getByPlaceholder('Senha da sala');
    await expect(pwInput).toBeFocused();
    await guest.page.keyboard.type('segredo42');
    await expect(pwInput).toHaveValue('segredo42');
    await expect(pwInput).toBeFocused();
    await guest.page.keyboard.press('Enter');

    await expect(pwDialog).toBeHidden();
    await expect(guest.page).toHaveURL(new RegExp(`/room/${code}$`));
    await expect(host.page.locator('aside[aria-label="Watch Party"]')).toContainText('Bia');
  } finally {
    await host.context.close();
    await guest.context.close();
  }
});
