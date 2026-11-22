import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_URL, SUBTITLES_URL, createRoom, joinRoom, newUser, state, submitName, togglePlay, waitReady } from './helpers';

/** Registra os pedidos de legenda e faz o `track` indicado falhar (como um PGS ou uma extração impossível). */
async function failTracks(page: Page, failing: number[]) {
  const requested: number[] = [];
  await page.route(/\/api\/subtitle\?/, async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get('status') === '1') return void await route.continue();
    const track = Number(params.get('track'));
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
const SRT_URL = 'http://127.0.0.1:3101/legendas-srt.mkv';
const preparingBadge = (page: Page) => page.getByRole('status').filter({ hasText: /legenda|fontes|renderizador|CDN|servidor de origem/i });

function rendererErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /legenda|subtitle|JASSUB|LibASS|VTT/i.test(message.text())) errors.push(message.text());
  });
  return errors;
}

async function createRoomWithExternalSubtitle(page: Page, format: 'srt' | 'vtt') {
  // Adiciona antes de criar a sala: a descoberta recebe a fonte externa sem depender
  // da extração/renderização de ASS nem de alterações na lista durante o playback.
  await page.goto('/');
  await page.getByRole('button', { name: /Colar link de stream/ }).click();
  await page.getByRole('textbox', { name: 'URL do stream' }).fill(FIXTURE_URL);
  await page.getByRole('button', { name: 'Legenda', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Adicionar legenda' });
  await dialog.getByLabel('Nome da faixa').fill(`Externa ${format.toUpperCase()}`);
  await dialog.getByLabel('URL da legenda').fill(`http://127.0.0.1:3101/externa.${format}`);
  await dialog.getByRole('tab', { name: 'VTT', exact: true }).click();
  await dialog.getByRole('button', { name: 'Adicionar legenda', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Criar sala', exact: true }).click();
  await submitName(page, 'Ana');
  await expect(page).toHaveURL(/\/room\/[A-Z0-9]+|\?room=[A-Z0-9]+/);
  await expect(page.locator('video')).toBeAttached();
}

test('SRT embutido entregue como ASS espera o JASSUB real antes de liberar playback', async ({ browser }, testInfo) => {
  const { page, context } = await newUser(browser);
  const errors = rendererErrors(page);
  let releaseWasm!: () => void;
  const wasmGate = new Promise<void>((resolve) => { releaseWasm = resolve; });
  let wasmRequested = false;
  await context.route(/\/jassub\/wasm\/[^?]+\.wasm(?:\?|$)/, async (route) => {
    wasmRequested = true;
    await wasmGate;
    await route.continue();
  });
  try {
    const subtitleResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/subtitle' && url.searchParams.get('status') !== '1';
    });
    await createRoom(page, 'Ana', SRT_URL);
    const response = await subtitleResponse;
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain('[Events]');
    await expect.poll(() => wasmRequested, { timeout: 30_000 }).toBe(true);
    await waitReady(page);
    await expect(preparingBadge(page)).toBeVisible();
    expect((await state(page)).paused).toBe(true);

    releaseWasm();
    const canvas = page.locator('canvas.JASSUB');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width > 0 && c.height > 0)).toBe(true);
    await expect(preparingBadge(page)).toBeHidden({ timeout: 30_000 });
    await expect(failurePrompt(page)).toBeHidden();
    // Salas novas começam pausadas: só após readiness solicitamos play como Host.
    await togglePlay(page);
    await expect.poll(async () => (await state(page)).paused).toBe(false);
    await expect.poll(async () => (await state(page)).t).toBeGreaterThan(1);
    await page.getByRole('region', { name: 'Video Player', exact: true }).screenshot({ path: testInfo.outputPath('embedded-srt.png') });
    expect(await page.locator('video track').evaluateAll((tracks: HTMLTrackElement[]) =>
      tracks.some((track) => track.track.mode === 'showing' && (track.track.cues?.length || 0) > 0)
    )).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    releaseWasm();
    await context.close();
  }
});

for (const format of ['srt', 'vtt'] as const) {
  test(`externa ${format.toUpperCase()}: cues nativos carregados e sincronia manual reversível`, async ({ browser }, testInfo) => {
    const { page, context } = await newUser(browser);
    const errors = rendererErrors(page);
    try {
      await createRoomWithExternalSubtitle(page, format);
      await waitReady(page);
      // Confere o track VTT preparado pelo gerenciador, que recebe os offsets.
      const track = page.locator(`video track[label="Externa ${format.toUpperCase()}"][src^="blob:"]`);
      await expect(track).toHaveCount(1);
      await expect(page.locator('video track[kind="subtitles"]')).toHaveCount(1);
      await expect.poll(() => track.evaluate((t: HTMLTrackElement) => ({
        loaded: t.readyState, mode: t.track.mode, count: t.track.cues?.length,
      }))).toEqual({ loaded: 2, mode: 'showing', count: 2 });
      await expect(page.locator('canvas.JASSUB')).toHaveCount(0);
      await expect(preparingBadge(page)).toBeHidden();
      await expect(failurePrompt(page)).toBeHidden();
      await page.locator('video').evaluate((video: HTMLVideoElement) => { video.pause(); video.currentTime = 2; });
      await expect.poll(() => track.evaluate((t: HTMLTrackElement) =>
        Array.from(t.track.activeCues || [], (cue: VTTCue) => cue.text)
      )).toEqual([`Legenda ${format.toUpperCase()} para o teste do Lunio`]);
      await page.getByRole('region', { name: 'Video Player', exact: true }).screenshot({ path: testInfo.outputPath(`external-${format}.png`) });

      const windows = () => track.evaluate((t: HTMLTrackElement) =>
        Array.from(t.track.cues || [], (cue) => [cue.startTime, cue.endTime])
      );
      await expect.poll(windows).toEqual([[0.5, 8], [10, 18]]);
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Shift+h');
      await expect.poll(windows).toEqual([[0.25, 7.75], [9.75, 17.75]]);
      await page.keyboard.press('Shift+h');
      await expect.poll(windows).toEqual([[0, 7.5], [9.5, 17.5]]);
      await page.keyboard.press('Shift+g');
      await page.keyboard.press('Shift+g');
      await expect.poll(windows).toEqual([[0.5, 8], [10, 18]]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test('HTTP 200 com HTML não libera a legenda obrigatória nem fica preparando para sempre', async ({ browser }) => {
  const { page, context } = await newUser(browser);
  await page.route(/\/api\/subtitle\?/, async (route) => {
    if (new URL(route.request().url()).searchParams.get('status') === '1') return void await route.continue();
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Erro da origem, não é uma legenda.</body></html>' });
  });
  try {
    await createRoom(page, 'Ana', SRT_URL);
    await expect(failurePrompt(page)).toBeVisible({ timeout: 30_000 });
    await expect(preparingBadge(page)).toBeHidden();
    expect((await state(page)).paused).toBe(true);
    await expect(page.locator('canvas.JASSUB')).toHaveCount(0);
    await failurePrompt(page).getByRole('button', { name: 'Assistir sem legenda' }).click();
    await expect(failurePrompt(page)).toBeHidden();
    await expect.poll(async () => (await state(page)).paused).toBe(false);
  } finally {
    await context.close();
  }
});

test('fonte embutida com 503 sai de loading_fonts com falha obrigatória', async ({ browser }) => {
  const { page, context } = await newUser(browser);
  let releaseFont!: () => void;
  const fontGate = new Promise<void>((resolve) => { releaseFont = resolve; });
  const fonts: string[] = [];
  await context.route(/\/api\/font\?/, async (route) => {
    fonts.push(new URL(route.request().url()).searchParams.get('name') || '');
    await fontGate;
    await route.fulfill({ status: 503, body: 'Fonte indisponível' });
  });
  try {
    await createRoom(page, 'Ana', SUBTITLES_URL);
    await expect.poll(() => fonts.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(preparingBadge(page)).toContainText('Carregando fontes da legenda');
    expect((await state(page)).paused).toBe(true);
    releaseFont();
    await expect(failurePrompt(page)).toContainText('SUBTITLE_FONT_FAILED', { timeout: 30_000 });
    await expect(preparingBadge(page)).toBeHidden();
    await expect(page.locator('canvas.JASSUB')).toHaveCount(0);
    expect((await state(page)).paused).toBe(true);
    expect(fonts).toEqual(['trebuc.ttf']);
  } finally {
    releaseFont();
    await context.close();
  }
});

test('waiting_cdn descreve a espera real; conteúdo e renderer prontos encerram o polling', async ({ browser }) => {
  const { page, context } = await newUser(browser);
  const errors = rendererErrors(page);
  let releaseContent!: () => void;
  const contentGate = new Promise<void>((resolve) => { releaseContent = resolve; });
  let downloads = 0;
  let polls = 0;
  await page.route(/\/api\/subtitle\?/, async (route) => {
    if (new URL(route.request().url()).searchParams.get('status') === '1') {
      polls++;
      return void await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ stage: 'waiting_cdn', updatedAt: Date.now(), retryAt: Date.now() + 5000 }),
      });
    }
    downloads++;
    await contentGate;
    await route.continue();
  });
  try {
    await createRoom(page, 'Ana', SRT_URL);
    await waitReady(page);
    await expect(preparingBadge(page)).toContainText('Aguardando o servidor de origem', { timeout: 30_000 });
    expect(polls).toBeGreaterThan(0);
    expect(downloads).toBe(1);
    expect((await state(page)).paused).toBe(true);
    await expect(page.locator('canvas.JASSUB')).toHaveCount(0);
    releaseContent();
    await expect(page.locator('canvas.JASSUB')).toBeVisible({ timeout: 30_000 });
    await expect(preparingBadge(page)).toBeHidden({ timeout: 30_000 });
    await expect(failurePrompt(page)).toBeHidden();
    await togglePlay(page);
    await expect.poll(async () => (await state(page)).paused).toBe(false);
    const finishedPolls = polls;
    // O intervalo do contrato é 1 s: observa mais de um ciclo após a conclusão.
    await page.waitForTimeout(1500);
    expect(polls).toBe(finishedPolls);
    expect(downloads).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    releaseContent();
    await context.close();
  }
});

test('troca rápida PT → EN: conclusão antiga não libera a nova faixa ainda pendente', async ({ browser }) => {
  const { page, context } = await newUser(browser);
  const errors = rendererErrors(page);
  let releasePt!: () => void;
  let releaseEn!: () => void;
  const ptGate = new Promise<void>((resolve) => { releasePt = resolve; });
  const enGate = new Promise<void>((resolve) => { releaseEn = resolve; });
  const requested: number[] = [];
  let ptBuffered = false;
  let ptDelivered = false;
  await page.route(/\/api\/subtitle\?/, async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get('status') === '1') return void await route.continue();
    const track = Number(params.get('track'));
    requested.push(track);
    const response = await route.fetch();
    if (track === 4) ptBuffered = true;
    await (track === 4 ? ptGate : enGate);
    await route.fulfill({ response });
    if (track === 4) ptDelivered = true;
  });
  try {
    await createRoom(page, 'Ana', SUBTITLES_URL);
    await expect.poll(() => requested).toEqual([4]);
    // Atrasamos a entrega de uma resposta completa, sem disputar a extração real
    // com o aborto do fetch quando o usuário escolhe outra faixa.
    await expect.poll(() => ptBuffered, { timeout: 30_000 }).toBe(true);
    await page.mouse.move(640, 360);
    await page.locator('#btn-subtitles-toggle').click();
    await page.getByRole('menuitemradio', { name: /Inglês/ }).click();
    await expect.poll(() => requested).toEqual([4, 3]);
    await expect(preparingBadge(page)).toContainText('Inglês');
    releasePt();
    await expect.poll(() => ptDelivered, { timeout: 30_000 }).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(preparingBadge(page)).toContainText('Inglês');
    await expect(failurePrompt(page)).toBeHidden();
    expect((await state(page)).paused).toBe(true);
    await expect(page.locator('canvas.JASSUB')).toHaveCount(0);
    releaseEn();
    await expect(page.locator('canvas.JASSUB')).toBeVisible({ timeout: 30_000 });
    await expect(preparingBadge(page)).toBeHidden({ timeout: 30_000 });
    await togglePlay(page);
    await expect.poll(async () => (await state(page)).paused).toBe(false);
    await page.mouse.move(640, 360);
    await page.locator('#btn-subtitles-toggle').click();
    await expect(page.getByRole('menuitemradio', { name: /Inglês/, checked: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    releasePt();
    releaseEn();
    await context.close();
  }
});

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

test('fontes: o player baixa só a fonte que a legenda usa (o MKV traz duas, a PT cita uma)', async ({ browser }) => {
  const { page, context } = await newUser(browser);
  const fontFiles: string[] = [];
  let mapped = false;
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/font') fontFiles.push(u.searchParams.get('name') || '');
  });
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/fontmap' && r.ok()) mapped = true;
  });

  await createRoom(page, 'Ana', SUBTITLES_URL);
  await waitReady(page);
  // O ranking escolhe a PT (Trebuchet MS, anexada); a "outra.ttf" (família renomeada) ninguém cita
  await expect.poll(() => mapped, { timeout: 30_000 }).toBe(true);
  await expect.poll(() => fontFiles.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2500); // dá tempo de um eventual pedido a mais aparecer
  expect(fontFiles).toEqual(['trebuc.ttf']);

  await context.close();
});
