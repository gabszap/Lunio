import { defineConfig } from '@playwright/test';

const PORT = 3100;

/**
 * E2E contra o servidor de PRODUÇÃO (`npm run serve`, precisa do `dist/`: o script `test:e2e` faz o build).
 * O vídeo vem de um servidor de fixture local (MKV gerado com FFmpeg), então não depende de TorBox nem de internet.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'pt-BR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  webServer: [
    {
      command: 'node e2e/fixture-server.mjs',
      url: 'http://127.0.0.1:3101/ready',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'npm run serve',
      url: `http://127.0.0.1:${PORT}/api/status`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(PORT),
        HOST: '127.0.0.1',
        ALLOW_PRIVATE_URLS: '1', // só aqui: o proxy precisa alcançar o fixture em 127.0.0.1
        SESSION_SECRET: 'segredo-e2e',
      },
    },
  ],
});
