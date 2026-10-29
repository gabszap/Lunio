import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createRoom, joinRoom, newUser, openParticipants, video, waitReady } from './helpers';

/**
 * Transmissão de tela, de ponta a ponta com o motor FALSO: servidor, WebSocket, token, chaves, interface e ciclo de
 * vida são os de verdade; só a captura/codec/relay são trocados (o Chromium do CI não codifica H.264 e não há relay).
 * O motor real é coberto pelo Vitest e por roteiros manuais contra o relay da Cloudflare.
 */

interface FakeLog {
  pub: Array<{ type: string; quality?: string; epoch?: number; hasUrl?: boolean }>;
  view: string[];
  keys: number[];
}

/** Roda na página antes de o app carregar. */
function installFakeEngine() {
  const w = window as unknown as { __screenLog: FakeLog; __cancelPicker?: boolean };
  w.__screenLog = { pub: [], view: [], keys: [] };
  const log = w.__screenLog;
  const keyFor = (epoch: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(epoch)));
  (globalThis as unknown as { __LUNIO_SCREEN_ENGINE__: unknown }).__LUNIO_SCREEN_ENGINE__ = {
    async createPublisher() {
      let epoch = 1;
      return {
        stats: { hasSubscribers: true },
        async start(opts: { quality: { id: string }; initialKey: { epoch: number }; url: string }) {
          log.pub.push({ type: 'start', quality: opts.quality.id, epoch: opts.initialKey.epoch, hasUrl: Boolean(opts.url) });
          if (w.__cancelPicker) throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
        },
        async rotateKey() {
          epoch += 1;
          log.pub.push({ type: 'rotate', epoch });
          return { epoch, key: keyFor(epoch) };
        },
        async stop() {
          log.pub.push({ type: 'stop' });
        },
        async flush() {},
      };
    },
    async createViewer(events: { onStatus(s: string, d?: string): void }) {
      let canvas: HTMLCanvasElement | null = null;
      const draw = () => {
        if (!canvas) return;
        canvas.width = 320;
        canvas.height = 180;
        const g = canvas.getContext('2d')!;
        g.fillStyle = '#2a6';
        g.fillRect(0, 0, 320, 180);
      };
      return {
        attach(c: HTMLCanvasElement) {
          canvas = c;
        },
        async addKey(k: { epoch: number }) {
          log.keys.push(k.epoch);
        },
        async watch() {
          log.view.push('watch');
          events.onStatus('waiting');
          draw();
          events.onStatus('watching');
        },
        pause() {
          log.view.push('pause');
          events.onStatus('paused');
        },
        resume() {
          log.view.push('resume');
          draw();
          events.onStatus('watching');
        },
        setVolume() {},
        async setSinkId() {},
        stop() {
          log.view.push('stop');
        },
        stats: {},
      };
    },
  };
}

async function user(browser: import('@playwright/test').Browser) {
  const u = await newUser(browser);
  await u.page.addInitScript(installFakeEngine);
  return u;
}

const shareBtn = (p: Page) => p.locator('#btn-screen-share');
const canvas = (p: Page) => p.locator('canvas[aria-hidden="true"]');
const log = (p: Page) => p.evaluate(() => (window as unknown as { __screenLog: FakeLog }).__screenLog);
const live = async (p: Page) => (await (await p.request.get('/api/status')).json()).screen.live as number;

async function reveal(p: Page) {
  await p.mouse.move(640, 500);
  await p.mouse.move(660, 520);
}

async function startSharing(host: Page, quality = /720p 60 fps/) {
  await reveal(host);
  await shareBtn(host).click();
  await host.getByRole('menuitemradio', { name: quality }).click();
  await host.getByRole('button', { name: 'Transmitir', exact: true }).click();
  await expect(host.getByText('Transmitindo').first()).toBeVisible();
}

async function watch(p: Page) {
  await p.getByRole('button', { name: 'Assistir transmissão' }).click();
  await expect(canvas(p)).toBeVisible();
  // o palco aparece ao conectar; o espectador (falso) só conclui depois do token
  await expect.poll(async () => (await log(p)).view).toContain('watch');
}

const closeAll = async (...ctxs: BrowserContext[]) => {
  for (const c of ctxs) await c.close().catch(() => {});
};

test.describe('transmissão de tela (motor falso)', () => {
  test('roteiro: só o Host vê o botão, transmitir, assistir, voltar ao vídeo e parar', async ({ browser }) => {
    const host = await user(browser);
    const guest = await user(browser);
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    await waitReady(guest.page);

    await reveal(host.page);
    await expect(shareBtn(host.page)).toBeVisible();
    await reveal(guest.page);
    await expect(shareBtn(guest.page)).toHaveCount(0);

    const base = await live(host.page); // o contador é do servidor todo: compara com a linha de base
    await startSharing(host.page, /720p 60 fps/);
    const pubLog = await log(host.page);
    expect(pubLog.pub[0]).toEqual({ type: 'start', quality: '720p60', epoch: 1, hasUrl: true });
    await expect.poll(() => live(host.page)).toBe(base + 1);

    // o espectador vê o cartão, assiste e recebe a chave
    await expect(guest.page.getByText('O Host está transmitindo a tela')).toBeVisible();
    await watch(guest.page);
    expect((await log(guest.page)).keys).toEqual([1]);
    expect(await video(guest.page).evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
    await expect(guest.page.getByText(/Vídeo pausado por/)).toHaveCount(0);

    // voltar ao vídeo e assistir de novo (sem novo espectador: retoma)
    await guest.page.getByRole('button', { name: 'Voltar ao vídeo' }).click();
    await expect(canvas(guest.page)).toBeHidden();
    expect(await video(guest.page).evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
    await guest.page.getByRole('button', { name: 'Assistir transmissão' }).click();
    await expect(canvas(guest.page)).toBeVisible();
    await expect.poll(async () => (await log(guest.page)).view).toContain('resume');
    const viewLog = (await log(guest.page)).view;
    expect(viewLog.filter((e) => e === 'watch')).toHaveLength(1);
    expect(viewLog).toContain('pause');

    // parar: o servidor zera e o espectador é avisado
    const notice = expect(guest.page.getByText('A transmissão acabou')).toBeVisible();
    await host.page.getByRole('button', { name: 'Parar transmissão' }).first().click();
    await expect.poll(() => live(host.page)).toBe(base);
    await notice;
    expect((await log(host.page)).pub.at(-1)!.type).toBe('stop');

    await closeAll(host.context, guest.context);
  });

  test('a chave gira quando alguém é expulso, banido ou sai, e quem fica recebe a nova', async ({ browser }) => {
    const host = await user(browser);
    const stays = await user(browser);
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(stays.page, code, 'Bia');
    await waitReady(host.page);
    await startSharing(host.page);
    await watch(stays.page);
    expect((await log(stays.page)).keys).toEqual([1]);

    // expulsar
    const kicked = await user(browser);
    await joinRoom(kicked.page, code, 'Cris');
    await watch(kicked.page);
    await openParticipants(host.page);
    await host.page.getByRole('button', { name: 'Expulsar da sala' }).last().click();
    await expect(kicked.page).not.toHaveURL(/room=/, { timeout: 15_000 });
    await expect.poll(async () => (await log(host.page)).pub.filter((e) => e.type === 'rotate').length, { timeout: 15_000 }).toBe(1);
    await expect.poll(async () => (await log(stays.page)).keys, { timeout: 15_000 }).toEqual([1, 2]);

    // banir
    const banned = await user(browser);
    await joinRoom(banned.page, code, 'Duda');
    await watch(banned.page);
    await openParticipants(host.page);
    await host.page.getByRole('button', { name: 'Banir da sala' }).last().click();
    await expect(banned.page).not.toHaveURL(/room=/, { timeout: 15_000 });
    await expect.poll(async () => (await log(stays.page)).keys, { timeout: 15_000 }).toEqual([1, 2, 3]);

    // sair (fecha a aba: o servidor espera a graça de 4 s antes de contar a saída)
    const leaves = await user(browser);
    await joinRoom(leaves.page, code, 'Edu');
    await watch(leaves.page);
    await leaves.context.close();
    await expect.poll(async () => (await log(stays.page)).keys, { timeout: 20_000 }).toEqual([1, 2, 3, 4]);

    expect((await log(host.page)).pub.filter((e) => e.type === 'rotate').map((e) => e.epoch)).toEqual([2, 3, 4]);
    await closeAll(host.context, stays.context, kicked.context, banned.context);
  });

  test('cancelar o seletor de tela não deixa transmissão no servidor nem alerta', async ({ browser }) => {
    const host = await user(browser);
    await host.page.addInitScript(() => {
      (window as unknown as { __cancelPicker: boolean }).__cancelPicker = true;
    });
    await createRoom(host.page, 'Ana');
    await waitReady(host.page);
    const base = await live(host.page);
    await reveal(host.page);
    await shareBtn(host.page).click();
    await host.page.getByRole('button', { name: 'Transmitir', exact: true }).click();
    await expect.poll(async () => (await log(host.page)).pub.map((e) => e.type)).toContain('start');
    await expect.poll(async () => (await log(host.page)).pub.map((e) => e.type)).toContain('stop');
    expect(await live(host.page)).toBe(base);
    await expect(host.page.getByText('Transmitindo')).toHaveCount(0);
    await expect(host.page.getByRole('alert')).toHaveCount(0);
    await reveal(host.page);
    await shareBtn(host.page).click();
    await expect(host.page.getByText('Você cancelou a seleção da tela.')).toBeVisible();
    await host.context.close();
  });

  test('o Host recarrega a página: a transmissão órfã é encerrada para todos', async ({ browser }) => {
    const host = await user(browser);
    const guest = await user(browser);
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    const base = await live(host.page);
    await startSharing(host.page);
    await watch(guest.page);
    const notice = expect(guest.page.getByText('A transmissão acabou')).toBeVisible({ timeout: 25_000 });
    await host.page.reload();
    await expect.poll(() => live(host.page), { timeout: 20_000 }).toBe(base);
    await notice;
    await closeAll(host.context, guest.context);
  });

  test('trocar o Host encerra a transmissão para todos', async ({ browser }) => {
    const host = await user(browser);
    const guest = await user(browser);
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    const base = await live(host.page);
    await startSharing(host.page);
    await watch(guest.page);
    const notice = expect(guest.page.getByText('A transmissão acabou')).toBeVisible({ timeout: 25_000 });
    await openParticipants(host.page);
    await host.page.getByRole('button', { name: 'Passar Host' }).first().click();
    await expect.poll(() => live(host.page), { timeout: 20_000 }).toBe(base);
    await notice;
    await closeAll(host.context, guest.context);
  });
});
