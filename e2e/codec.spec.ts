import { expect, test, type Page } from '@playwright/test';
import { createRoom, newUser } from './helpers';

/**
 * O servidor nunca recodifica vídeo: quem decodifica é o navegador. Quando ele não decodifica o codec do arquivo, o
 * áudio toca e a imagem não aparece, sem erro. O player avisa. Aqui o resultado esperado depende do que ESTE
 * navegador de teste decodifica (o Chromium do Playwright não decodifica HEVC), então o teste pergunta a ele antes.
 */

const BASE = 'http://127.0.0.1:3101';

const canDecode = (page: Page, contentType: string) =>
  page.evaluate((ct) => document.createElement('video').canPlayType(ct) !== '', contentType);

async function fixtureExists(page: Page, name: string) {
  return (await page.request.head(`${BASE}/${name}`)).ok();
}

const CASES = [
  { file: 'codec-hevc.mkv', label: 'HEVC (H.265)', type: 'video/mp4; codecs="hvc1.1.6.L153.B0"' },
  { file: 'codec-hevc10.mkv', label: 'HEVC (H.265) 10 bits', type: 'video/mp4; codecs="hvc1.2.4.L153.B0"' },
  { file: 'codec-av1.mkv', label: 'AV1', type: 'video/mp4; codecs="av01.0.13M.08"' },
  { file: 'codec-h264-10bit.mkv', label: 'H.264 10 bits', type: 'video/mp4; codecs="avc1.6E0033"' },
];

for (const c of CASES) {
  test(`${c.label}: o aviso aparece se e só se este navegador não decodifica`, async ({ browser }) => {
    const { context, page } = await newUser(browser);
    test.skip(!(await fixtureExists(page, c.file)), `o FFmpeg local não gerou ${c.file}`);
    const supported = await canDecode(page, c.type);

    await createRoom(page, 'Ana', `${BASE}/${c.file}`);
    const notice = page.locator('#video-codec-notice');
    if (supported) {
      // Dá tempo de a leitura das faixas e do vídeo acontecerem e confere que nada foi avisado
      await expect.poll(async () => (await page.evaluate(() => document.querySelector('video')?.readyState ?? 0)), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
      await page.waitForTimeout(2500);
      await expect(notice).toHaveCount(0);
    } else {
      await expect(notice).toBeVisible({ timeout: 20_000 });
      await expect(notice).toContainText('Este vídeo pode não aparecer');
      await notice.getByRole('button', { name: 'Fechar aviso' }).click();
      await expect(notice).toHaveCount(0);
    }
    await context.close();
  });
}

test('H.264 comum não gera aviso', async ({ browser }) => {
  const { context, page } = await newUser(browser);
  await createRoom(page, 'Ana');
  await expect.poll(async () => (await page.evaluate(() => document.querySelector('video')?.readyState ?? 0)), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(2500);
  await expect(page.locator('#video-codec-notice')).toHaveCount(0);
  await context.close();
});
