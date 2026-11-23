import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createRoom, joinRoom, newUser, state, togglePlay, video, waitReady } from './helpers';
import type { ClientMessage } from '../src/types/sync';

declare global {
  interface Window {
    testRoomSocket?: WebSocket;
  }
}

function trackRoomSocket(page: Page) {
  return page.addInitScript(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (new URL(this.url).pathname === '/api/ws') window.testRoomSocket = this;
      return send.call(this, data);
    };
  });
}

function hostCommand(page: Page, message: ClientMessage) {
  return page.evaluate((message) => window.testRoomSocket!.send(JSON.stringify(message)), message);
}

async function disconnectRoom({ context, page }: { context: BrowserContext; page: Page }) {
  await context.setOffline(true);
  await page.evaluate(() => window.testRoomSocket!.close());
  await expect.poll(() => page.evaluate(() => window.testRoomSocket?.readyState === WebSocket.CLOSED)).toBe(true);
}

test('quem entra ou reconecta aplica pausa, posição e velocidade da sala', async ({ browser }) => {
  const host = await newUser(browser);
  const guest = await newUser(browser);
  await trackRoomSocket(host.page);
  await trackRoomSocket(guest.page);
  try {
    const code = await createRoom(host.page, 'Ana');
    await waitReady(host.page);
    await hostCommand(host.page, { type: 'playback:seek', position: 25 });
    await hostCommand(host.page, { type: 'playback:rate', rate: 1.5 });

    await joinRoom(guest.page, code, 'Bia');
    await waitReady(guest.page);
    await expect.poll(async () => (await state(guest.page)).t).toBeCloseTo(25, 0);
    expect((await state(guest.page)).paused).toBe(true);
    expect(await video(guest.page).evaluate((el: HTMLVideoElement) => el.playbackRate)).toBe(1.5);

    await disconnectRoom(guest);
    await hostCommand(host.page, { type: 'playback:seek', position: 40 });
    await hostCommand(host.page, { type: 'playback:rate', rate: 1.25 });
    await guest.context.setOffline(false);

    await expect.poll(async () => (await state(guest.page)).t).toBeCloseTo(40, 0);
    expect((await state(guest.page)).paused).toBe(true);
    expect(await video(guest.page).evaluate((el: HTMLVideoElement) => el.playbackRate)).toBe(1.25);
  } finally {
    await host.context.close();
    await guest.context.close();
  }
});

test('o espectador corrige um desvio grande na posição local', async ({ browser }) => {
  const host = await newUser(browser);
  const guest = await newUser(browser);
  try {
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    await waitReady(guest.page);
    await togglePlay(host.page);
    await expect.poll(async () => (await state(guest.page)).paused).toBe(false);

    const before = (await state(host.page)).t;
    const jump = await video(guest.page).evaluate((el: HTMLVideoElement) => {
      el.currentTime += 20;
      return el.currentTime;
    });
    expect(jump - before).toBeGreaterThan(10);
    await expect.poll(async () => Math.abs((await state(host.page)).t - (await state(guest.page)).t)).toBeLessThan(2);
    expect((await state(host.page)).t).toBeLessThan(jump - 5);
  } finally {
    await host.context.close();
    await guest.context.close();
  }
});

test('o remux de áudio alternativo respeita a pausa do host após reconectar', async ({ browser }) => {
  const host = await newUser(browser);
  const guest = await newUser(browser);
  await trackRoomSocket(host.page);
  await trackRoomSocket(guest.page);
  await guest.page.route('**/api/hls/start**', (route) => route.fulfill({ status: 503 }));
  try {
    const code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    await waitReady(guest.page);
    await togglePlay(host.page);
    await expect.poll(async () => (await state(guest.page)).paused).toBe(false);

    await guest.page.getByRole('button', { name: 'Faixas de áudio' }).click();
    await guest.page.getByRole('menuitemradio', { name: /Português/ }).click();
    await expect.poll(async () => (await state(guest.page)).src).toContain('audio=');
    await waitReady(guest.page);
    await expect.poll(async () => (await state(guest.page)).paused).toBe(false);

    await disconnectRoom(guest);
    await togglePlay(host.page);
    await expect.poll(async () => (await state(host.page)).paused).toBe(true);
    await hostCommand(host.page, { type: 'playback:seek', position: 35 });
    await guest.context.setOffline(false);

    await expect.poll(async () => {
      const { src, paused, rs } = await state(guest.page);
      const url = src && new URL(src);
      return Boolean(url && url.searchParams.has('audio') && Number(url.searchParams.get('ss')) === 35 && paused && rs >= 2);
    }).toBe(true);
  } finally {
    await host.context.close();
    await guest.context.close();
  }
});
