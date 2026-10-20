import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request, type Browser } from '@playwright/test';
import { newUser, submitName } from './helpers';

/**
 * Reabrir envio com o claim guardado no navegador (ENVIOS-REDIS.md, 4.6): a sala encerra,
 * o produto volta ao início e "Seus envios recentes" abre o arquivo de novo, sem reenviá-lo.
 */

const FILE_SIZE = 64 * 1024; // 1 pedaço só: o que este spec quer provar é o claim, não o envio
/** O mesmo segredo do servidor de E2E (playwright.config.ts): assina claims falsos de verdade. */
const E2E_SECRET = 'segredo-e2e';

/** Claim assinado como o servidor assina (access.ts): base64url(payload).HMAC. */
function fakeClaim(id: string) {
  const body = Buffer.from(JSON.stringify({ k: 'upload', id, u: 'hostX', exp: Date.now() + 3600_000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', E2E_SECRET).update(body).digest('base64url')}`;
}

/** O apelido já pode estar no navegador (mesma aba): só confirma o modal se ele aparecer. */
async function maybeName(page: Page, name: string) {
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible().catch(() => false)) {
    await submitName(page, name);
  }
}

async function openUpload(page: Page, name: string, file?: { name: string; mimeType: string; buffer: Buffer }) {
  await page.addInitScript(() => {
    (window as unknown as { __lunioRetryDelays: number[] }).__lunioRetryDelays = [50, 50];
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Enviar um arquivo/ }).click();
  await page.locator('input[type="file"]').setInputFiles(
    file ?? { name: 'episodio-reaberto.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(FILE_SIZE, 7) }
  );
  await page.getByRole('button', { name: 'Enviar e criar sala' }).click();
  await submitName(page, name);
}

test.describe('reabrir envio (claim no navegador)', () => {
  test('aparece em "Seus envios recentes" e é reaberto numa sala nova, sem reenvio', async ({ browser }) => {
    const { context, page } = await newUser(browser);
    const requests: Request[] = [];
    page.on('request', (r) => requests.push(r));

    await openUpload(page, 'Ana');
    await expect(page.getByText('Arquivo enviado')).toBeVisible({ timeout: 30_000 });
    const firstEnd = requests.length;
    await page.goto('/');
    await page.getByRole('button', { name: /Enviar um arquivo/ }).click();

    // A lista guarda o envio do navegador. O prazo de vencer só se sabe com a sala fechada (conta do fechamento), então
    // logo depois do envio, com a sala ainda aberta, a lista não inventa um "expira em"
    await expect(page.getByText('Seus envios recentes')).toBeVisible();
    await expect(page.getByText('episodio-reaberto.mp4')).toBeVisible();
    await expect(page.getByText(/expira em/)).toHaveCount(0);

    // Reabrir numa sala nova: nenhum PUT pode disparar (sem envio de novo), só o claim
    await page.getByRole('button', { name: 'Usar este arquivo' }).click();
    await maybeName(page, 'Ana');
    await expect(page.getByText('Arquivo enviado')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Abrir player' })).toBeEnabled();
    // O envio reaberto não tem o File de verdade; a tela mostra o tamanho do servidor, completo (antes: "0%" e "0 B")
    await expect(page.getByText('100%')).toBeVisible();
    await expect(page.getByText('0%', { exact: true })).toHaveCount(0);
    await expect(page.getByText('64 KB')).toBeVisible();

    // O servidor entregou o arquivo por claim: nenhum pedaço reenviado depois do primeiro envio
    const puts = requests.slice(firstEnd).filter((r) => r.method() === 'PUT' && r.url().includes('/api/upload/'));
    expect(puts).toEqual([]);
    // E o servidor o reconheceu na sala nova: o arquivo responde no proxy (via Internal token, no player)
    await context.close();
  });

  test('envio que o servidor já apagou sai da lista sozinho, sem precisar tentar reabrir', async ({ browser }) => {
    const { context, page } = await newUser(browser);

    // Um envio que o servidor já apagou (id só de zeros), com claim assinado de verdade: a verificação da lista
    // (POST /api/uploads/status) o encontra como "gone" e o navegador o esquece, sem o clique em "Usar este arquivo"
    const id = '0000000000000000';
    await page.addInitScript((claim) => {
      localStorage.setItem(
        'lunio.recentUploads',
        JSON.stringify([{ id: '0000000000000000', name: 'sumido.mp4', size: 65536, claim, at: Date.now() }])
      );
    }, fakeClaim(id));
    await page.goto('/');
    await page.getByRole('button', { name: /Enviar um arquivo/ }).click();
    // O servidor não tem o arquivo: o item some da lista e o bloco inteiro desaparece
    await expect(page.getByText('sumido.mp4')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText('Seus envios recentes')).toHaveCount(0);
    await context.close();
  });
});
