import { expect, test, type Page, type Request } from '@playwright/test';
import { newUser, submitName } from './helpers';

/**
 * Envio de arquivo em pedaços. O servidor de teste usa pedaços de 64 KiB (UPLOAD_CHUNK_MB, ver playwright.config.ts),
 * então um arquivo pequeno já passa por vários pedidos, como um arquivo grande passaria atrás da Cloudflare.
 */

const FILE_SIZE = 600 * 1024; // ~10 pedaços de 64 KiB

async function openUpload(page: Page, name: string) {
  // Esperas curtas entre as tentativas (o padrão de 1 a 15 s deixaria o teste lento)
  await page.addInitScript(() => {
    (window as unknown as { __lunioRetryDelays: number[] }).__lunioRetryDelays = [50, 50];
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Enviar um arquivo/ }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'episodio.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.alloc(FILE_SIZE, 5),
  });
  await page.getByRole('button', { name: 'Enviar e criar sala' }).click();
  await submitName(page, name);
}

const chunkOffsets = (requests: Request[]) =>
  requests.filter((r) => r.method() === 'PUT' && r.url().includes('/api/upload/')).map((r) => Number(new URL(r.url()).searchParams.get('offset')));

test.describe('envio de arquivo em pedaços', () => {
  test('sobe o arquivo todo em vários pedidos e libera o player', async ({ browser }) => {
    const { context, page } = await newUser(browser);
    const requests: Request[] = [];
    page.on('request', (r) => requests.push(r));

    await openUpload(page, 'Ana');
    await expect(page.getByText('Arquivo enviado')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Abrir player' })).toBeEnabled();

    const offsets = chunkOffsets(requests);
    expect(offsets.length).toBeGreaterThanOrEqual(9);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b)); // em ordem, sem repetir
    expect(new Set(offsets).size).toBe(offsets.length);
    await context.close();
  });

  test('uma queda no meio de um pedaço é tentada de novo sozinha, sem reenviar o que já chegou', async ({ browser }) => {
    const { context, page } = await newUser(browser);
    const requests: Request[] = [];
    page.on('request', (r) => requests.push(r));
    let failedOnce = false;
    await page.route('**/api/upload/*?offset=196608', async (route) => {
      if (!failedOnce) {
        failedOnce = true;
        return route.abort('connectionreset');
      }
      return route.continue();
    });

    await openUpload(page, 'Ana');
    await expect(page.getByText('Arquivo enviado')).toBeVisible({ timeout: 30_000 });

    const offsets = chunkOffsets(requests);
    expect(offsets.filter((o) => o === 196608)).toHaveLength(2); // tentou, caiu, tentou de novo
    expect(offsets.filter((o) => o < 196608).every((o, i, a) => a.indexOf(o) === i)).toBe(true); // o resto foi uma vez só
    await context.close();
  });

  test('conexão fora por muito tempo: mostra o erro e "Continuar o envio" retoma de onde parou', async ({ browser }) => {
    const { context, page } = await newUser(browser);
    const requests: Request[] = [];
    page.on('request', (r) => requests.push(r));
    let blocked = true;
    await page.route('**/api/upload/*?offset=131072', async (route) => (blocked ? route.abort('connectionreset') : route.continue()));

    await openUpload(page, 'Ana');
    await expect(page.getByText('A conexão caiu durante o envio.')).toBeVisible({ timeout: 30_000 });
    const resumeButton = page.getByRole('button', { name: 'Continuar o envio' });
    await expect(resumeButton).toBeVisible();

    blocked = false; // a rede voltou
    await resumeButton.click();
    await expect(page.getByText('Arquivo enviado')).toBeVisible({ timeout: 30_000 });

    // Os pedaços anteriores à queda (0 e 65536) foram enviados uma vez só; depois dela, o envio seguiu dali
    const offsets = chunkOffsets(requests);
    expect(offsets.filter((o) => o === 0)).toHaveLength(1);
    expect(offsets.filter((o) => o === 65536)).toHaveLength(1);
    expect(offsets.filter((o) => o === 131072).length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...offsets)).toBeGreaterThan(131072);
    await context.close();
  });
});
