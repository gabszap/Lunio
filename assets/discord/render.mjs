import { chromium } from '../../node_modules/playwright-core/index.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1208/chrome-win64/chrome.exe';
const b = await chromium.launch({ executablePath: exe });
const jobs = [['cover', 1024, 576, 'arte-de-capa.png', false], ['background', 1024, 576, 'plano-de-fundo.png', false], ['icon', 1024, 1024, 'icone-1024.png', true]];
for (const [n, w, h, out, transparent] of jobs) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.goto(pathToFileURL(path.resolve(n + '.html')).href);
  await p.waitForTimeout(300);
  await p.screenshot({ path: out, omitBackground: transparent });
  if (n === 'icon') await p.setViewportSize({ width: 512, height: 512 }), await p.evaluate(() => (document.documentElement.style.zoom = 0.5)), await p.screenshot({ path: 'icone-512.png', omitBackground: true });
}
await b.close();
