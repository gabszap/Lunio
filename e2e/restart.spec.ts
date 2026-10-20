import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import Redis from 'ioredis';
import { SUBTITLES_URL, createRoom, joinRoom, newUser, openParticipants, waitReady } from './helpers';

/**
 * Reiniciar o servidor no meio da sala (deploy, queda): com Redis a sala volta com Host, mídia e fila, e quem reconecta
 * primeiro não vira Host. Sobe um servidor PRÓPRIO na 3102 (o da 3100 é do Playwright e não dá para reiniciar daqui) e
 * só roda com um Redis de verdade: `REDIS_TEST_URL=redis://127.0.0.1:6379 npx playwright test e2e/restart.spec.ts`.
 */

const REDIS_URL = process.env.REDIS_TEST_URL;
const PORT = 3102;
const BASE = `http://127.0.0.1:${PORT}`;

test.skip(!REDIS_URL, 'precisa de REDIS_TEST_URL (um Redis de verdade)');
test.use({ baseURL: BASE });

function startServer(): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      ALLOW_PRIVATE_URLS: '1', // o proxy precisa alcançar o fixture em 127.0.0.1
      SESSION_SECRET: 'segredo-e2e',
      MIN_FREE_DISK_GB: '0',
      REDIS_URL,
      ROOM_HOST_GRACE_SECONDS: '40', // folga: a página do Host reconecta com espera crescente
    },
    stdio: 'ignore',
  });
}

async function waitUp() {
  await expect
    .poll(async () => (await fetch(`${BASE}/api/status`).catch(() => null))?.ok ?? false, { timeout: 60_000, intervals: [500] })
    .toBe(true);
}

async function stop(server: ChildProcess) {
  if (server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM'); // o servidor grava o estado das salas antes de sair (no Windows o kill é seco: vale o debounce)
  await exited;
}

test('restart do servidor: a sala volta com Host e fila, e quem reconecta primeiro não vira Host', async ({ browser }) => {
  test.setTimeout(150_000);
  let server = startServer();
  let code = '';
  const redis = new Redis(REDIS_URL!);
  const host = await newUser(browser);
  const guest = await newUser(browser);
  try {
    await waitUp();
    code = await createRoom(host.page, 'Ana');
    await joinRoom(guest.page, code, 'Bia');
    await waitReady(host.page);
    await waitReady(guest.page);

    await host.page.getByLabel('Link para adicionar à fila').fill(SUBTITLES_URL);
    await host.page.getByRole('button', { name: 'Adicionar à fila' }).click();
    await expect(host.page.getByText('Adicionado por Ana')).toBeVisible();
    await expect(guest.page.getByText('Adicionado por Ana')).toBeVisible();
    await expect.poll(() => redis.exists(`lunio:roomstate:${code}`), { timeout: 10_000 }).toBe(1); // gravado (debounce de 250 ms)
    await host.page.waitForTimeout(1000);

    // O servidor cai: as duas páginas avisam que estão reconectando
    await stop(server);
    await expect(guest.page.getByText('Reconectando à sala…')).toBeVisible({ timeout: 15_000 });
    await expect(host.page.getByText('Reconectando à sala…')).toBeVisible({ timeout: 15_000 });

    // Ana fica sem rede: a Bia reconecta primeiro (o pior caso para a regra do Host)
    await host.context.setOffline(true);
    server = startServer();
    await waitUp();
    await expect(guest.page.getByText('Reconectando à sala…')).toBeHidden({ timeout: 40_000 });

    await openParticipants(guest.page);
    await expect(guest.page.getByText('Você é espectador', { exact: true })).toBeVisible(); // não assumiu o Host
    await expect(guest.page.getByText('Adicionado por Ana')).toBeVisible(); // a fila voltou

    // A Ana volta e retoma o Host
    await host.context.setOffline(false);
    await expect(host.page.getByText('Reconectando à sala…')).toBeHidden({ timeout: 40_000 });
    await openParticipants(host.page);
    await expect(host.page.getByText('Você é o Host', { exact: true })).toBeVisible();
    await expect(host.page.getByText('Adicionado por Ana')).toBeVisible();
    await expect(guest.page.getByText('Você é espectador', { exact: true })).toBeVisible();
  } finally {
    await host.context.close();
    await guest.context.close();
    await stop(server);
    if (code) await redis.del(`lunio:roomstate:${code}`);
    redis.disconnect();
  }
});
