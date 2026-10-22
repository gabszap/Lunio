import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';

const ADDON_PORT = 3102;
const MANIFEST_URL = `http://127.0.0.1:${ADDON_PORT}/manifest.json`;

let addon: ChildProcess;

test.beforeAll(async () => {
  addon = spawn('node', ['e2e/fake-addon.mjs', String(ADDON_PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(MANIFEST_URL)).ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('addon de teste não subiu');
});

test.afterAll(() => {
  addon?.kill();
});

/** Fonte simulada do catálogo (o servidor do E2E não tem internet). */
async function mockCatalog(page: Page) {
  await page.route('**/api/catalog/**', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').pop();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'manifest') return json({ name: 'Fonte', isDefault: false, stale: false, rows: [{ type: 'movie', id: 'pop', name: 'Filmes populares', genres: [] }] });
    if (action === 'row') return json({ metas: [] });
    return json({ groups: [], stale: false });
  });
}

test.describe('Addons de vídeo', () => {
  test('adicionar um addon, ver nome e host sem expor a URL, manter após recarregar e remover', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mockCatalog(page);
    await page.goto('/catalog');

    await page.getByRole('button', { name: 'Addons' }).click();
    const dialog = page.getByRole('dialog', { name: 'Addons' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('URL do manifesto').fill('http://127.0.0.1:3102/nao-e-manifesto');
    await dialog.getByRole('button', { name: 'Adicionar' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Cole a URL do manifesto (termina em /manifest.json)');

    await dialog.getByLabel('URL do manifesto').fill(MANIFEST_URL);
    await dialog.getByRole('button', { name: 'Adicionar' }).click();
    await expect(dialog.getByText('Addon de teste')).toBeVisible();
    await expect(dialog.getByText(`127.0.0.1:${ADDON_PORT}`, { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('URL do manifesto')).toHaveValue('');
    expect(await page.content()).not.toContain(MANIFEST_URL);

    await dialog.getByLabel('URL do manifesto').fill(MANIFEST_URL);
    await dialog.getByRole('button', { name: 'Adicionar' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Esse addon já foi adicionado');

    await page.reload();
    await page.getByRole('button', { name: 'Addons' }).click();
    const again = page.getByRole('dialog', { name: 'Addons' });
    await expect(again.getByText('Addon de teste')).toBeVisible();

    await again.getByRole('button', { name: 'Remover' }).click();
    await expect(again.getByText('Addon de teste')).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: 'Addons' }).click();
    await expect(page.getByRole('dialog', { name: 'Addons' }).getByText('Addon de teste')).toHaveCount(0);
    await page.close();
  });

  test('falha ao atualizar aparece na linha do addon, sem marcar o campo de URL como inválido', async ({ browser }) => {
    const port = 3103;
    const url = `http://127.0.0.1:${port}/manifest.json`;
    const second = spawn('node', ['e2e/fake-addon.mjs', String(port)], { stdio: 'ignore' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      for (let i = 0; i < 50; i++) {
        try {
          if ((await fetch(url)).ok) break;
        } catch {
          // ainda subindo
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      await mockCatalog(page);
      await page.goto('/catalog');
      await page.getByRole('button', { name: 'Addons' }).click();
      const dialog = page.getByRole('dialog', { name: 'Addons' });
      await dialog.getByLabel('URL do manifesto').fill(url);
      await dialog.getByRole('button', { name: 'Adicionar' }).click();
      await expect(dialog.getByText(`127.0.0.1:${port}`, { exact: true })).toBeVisible();

      second.kill();
      await expect.poll(() => fetch(url).then(() => true, () => false)).toBe(false);
      await dialog.getByRole('button', { name: 'Atualizar Addon de teste' }).click();
      await expect(dialog.getByRole('alert')).toHaveText('Não consegui abrir esse endereço');
      await expect(dialog.getByLabel('URL do manifesto')).not.toHaveAttribute('aria-invalid', 'true');
      await dialog.getByRole('button', { name: 'Remover Addon de teste' }).click();
    } finally {
      second.kill();
      await page.close();
    }
  });
});
