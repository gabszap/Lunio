import { expect, test, type Page } from '@playwright/test';
import {
  FIXTURE_URL,
  createEmptyRoom,
  newUser,
  openParticipants,
  submitName,
  testClientHeaders,
  waitReady,
} from './helpers';

/** A partir de uma sala vazia, carrega uma URL de stream no player da sala. */
async function startMediaInRoom(page: Page, url = FIXTURE_URL) {
  await page.getByRole('button', { name: 'Escolher vídeo' }).click();
  await page.getByRole('tab', { name: 'Link de stream' }).click();
  await page.getByRole('textbox', { name: 'URL do stream' }).fill(url);
  await page.getByRole('button', { name: 'Tocar na sala', exact: true }).click();
  await expect(page.locator('video')).toBeAttached();
}

/** Clica em "Atualizar" na aba Salas esperando o botão voltar a ficar habilitado. */
async function refreshRoomsList(page: Page) {
  const btn = page.getByRole('button', { name: 'Atualizar' });
  await expect(btn).toBeEnabled();
  const resPromise = page.waitForResponse(
    (res) => new URL(res.url()).pathname === '/api/rooms' && res.request().method() === 'GET'
  );
  await btn.click();
  await resPromise;
}

/** Seleciona uma opção em um dos menus `FilterSelect` (atividade ou ordenação). */
async function pickFilterOption(page: Page, triggerLabel: string, optionLabel: string) {
  await page.getByRole('button', { name: triggerLabel }).click();
  await page.getByRole('option', { name: optionLabel }).click();
}

test.describe('Listagem de salas públicas (/rooms)', () => {
  test('aba Salas lista apenas salas públicas com nome, Host e contagem de pessoas', async ({ browser }) => {
    const viewer = await newUser(browser);
    const publicHost = await newUser(browser);
    const privateHost = await newUser(browser);
    try {
      await viewer.page.goto('/');
      await viewer.page.getByRole('tab', { name: 'Salas' }).click();
      await expect(viewer.page).toHaveURL(/\/rooms$/);
      await expect(viewer.page.getByRole('heading', { level: 1, name: 'Salas públicas' })).toBeVisible();
      await expect(viewer.page.getByText('Nenhuma sala pública aberta agora')).toBeVisible();

      await createEmptyRoom(publicHost.page, {
        username: 'Ana',
        roomName: 'Maratona Pública',
        visibility: 'public',
      });
      await createEmptyRoom(privateHost.page, {
        username: 'Bruno',
        roomName: 'Sala Secreta',
        visibility: 'private',
      });

      await refreshRoomsList(viewer.page);

      const publicCard = viewer.page.getByRole('button', { name: /Maratona Pública/ });
      await expect(publicCard).toBeVisible();
      await expect(publicCard).toContainText('Maratona Pública');
      await expect(publicCard).toContainText('Ana');
      await expect(publicCard).toContainText('1 pessoa');
      await expect(viewer.page.getByText('Sala Secreta')).toHaveCount(0);
    } finally {
      await viewer.context.close();
      await publicHost.context.close();
      await privateHost.context.close();
    }
  });

  test('trancar a sala pública remove a sala imediatamente de /rooms', async ({ browser }) => {
    const host = await newUser(browser);
    const viewer = await newUser(browser);
    try {
      const code = await createEmptyRoom(host.page, {
        username: 'Ana',
        roomName: 'Sala Para Trancar',
        visibility: 'public',
      });

      await viewer.page.goto('/rooms');
      const card = viewer.page.getByRole('button', { name: /Sala Para Trancar/ });
      await expect(card).toBeVisible();

      // Host tranca a sala pelo painel Membros -> Configurar sala
      await openParticipants(host.page);
      await host.page.getByRole('button', { name: 'Configurar sala' }).click();
      await host.page.getByLabel('Trancar sala (bloquear novas entradas)').check();
      await host.page.getByRole('button', { name: 'Salvar' }).click();
      await expect(host.page.getByText('Salvo')).toBeVisible();

      // Confirma que o servidor removeu a sala da listagem pública imediatamente
      await expect
        .poll(async () => {
          const res = await viewer.page.request.get('/api/rooms', {
            headers: testClientHeaders(viewer.context),
          });
          const data = (await res.json()) as { rooms: Array<{ code: string }> };
          return data.rooms.some((r) => r.code === code);
        })
        .toBe(false);

      await refreshRoomsList(viewer.page);
      await expect(card).toHaveCount(0);
    } finally {
      await host.context.close();
      await viewer.context.close();
    }
  });

  test('filtra por nome e atividade e ordena por mais pessoas e mais recentes', async ({ browser }) => {
    const mediaHost = await newUser(browser);
    const mediaGuest = await newUser(browser);
    const idleHost = await newUser(browser);
    const viewer = await newUser(browser);
    try {
      // Sala 1 (mais antiga, 2 pessoas, assistindo vídeo)
      const mediaCode = await createEmptyRoom(mediaHost.page, {
        username: 'Ana',
        roomName: 'Sessão Cinema',
        visibility: 'public',
      });
      await startMediaInRoom(mediaHost.page, FIXTURE_URL);
      await waitReady(mediaHost.page);

      await mediaGuest.page.goto(`/room/${mediaCode}`);
      await submitName(mediaGuest.page, 'Bia');
      await expect(mediaGuest.page.locator('video')).toBeAttached();

      // Sala 2 (mais recente, 1 pessoa, aguardando mídia)
      await createEmptyRoom(idleHost.page, {
        username: 'Carlos',
        roomName: 'Papo Livre',
        visibility: 'public',
      });

      await viewer.page.goto('/rooms');
      const cinemaCard = viewer.page.getByRole('button', { name: /Sessão Cinema/ });
      const papoCard = viewer.page.getByRole('button', { name: /Papo Livre/ });
      await expect(cinemaCard).toBeVisible();
      await expect(papoCard).toBeVisible();
      await expect(cinemaCard).toContainText('2 pessoas');
      await expect(papoCard).toContainText('1 pessoa');

      // Busca por nome
      const searchInput = viewer.page.getByPlaceholder('Pesquisar sala por nome...');
      await searchInput.fill('Cinema');
      await expect(cinemaCard).toBeVisible();
      await expect(papoCard).toHaveCount(0);

      await viewer.page.getByRole('button', { name: 'Limpar busca' }).click();
      await expect(cinemaCard).toBeVisible();
      await expect(papoCard).toBeVisible();

      // Filtro de atividade: "Assistindo vídeo" vs "Todas as salas"
      await pickFilterOption(viewer.page, 'Filtrar por atividade', 'Assistindo vídeo');
      await expect(cinemaCard).toBeVisible();
      await expect(papoCard).toHaveCount(0);

      await pickFilterOption(viewer.page, 'Filtrar por atividade', 'Todas as salas');
      await expect(cinemaCard).toBeVisible();
      await expect(papoCard).toBeVisible();

      // Ordenação: padrão "Mais pessoas" coloca Sessão Cinema (2) antes de Papo Livre (1)
      const cardOrder = () =>
        viewer.page
          .locator('main button')
          .filter({ hasText: /Sessão Cinema|Papo Livre/ })
          .allTextContents()
          .then((texts) => texts.map((txt) => (txt.includes('Sessão Cinema') ? 'Sessão Cinema' : 'Papo Livre')));

      await expect.poll(cardOrder).toEqual(['Sessão Cinema', 'Papo Livre']);

      // Ordenação "Mais recentes" coloca Papo Livre (criada depois) primeiro
      await pickFilterOption(viewer.page, 'Ordenar por', 'Mais recentes');
      await expect.poll(cardOrder).toEqual(['Papo Livre', 'Sessão Cinema']);

      // Voltar para "Mais pessoas" restaura Sessão Cinema primeiro
      await pickFilterOption(viewer.page, 'Ordenar por', 'Mais pessoas');
      await expect.poll(cardOrder).toEqual(['Sessão Cinema', 'Papo Livre']);
    } finally {
      await mediaHost.context.close();
      await mediaGuest.context.close();
      await idleHost.context.close();
      await viewer.context.close();
    }
  });

  test('publica snapshot automático da sala com vídeo e exibe imagem válida no card em /rooms', async ({ browser }) => {
    const host = await newUser(browser);
    const viewer = await newUser(browser);
    try {
      const code = await createEmptyRoom(host.page, {
        username: 'Ana',
        roomName: 'Sala com Preview',
        visibility: 'public',
      });

      const uploadPromise = host.page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === '/api/roompreview' &&
          res.request().method() === 'PUT' &&
          res.ok(),
        { timeout: 35_000 }
      );

      await startMediaInRoom(host.page, FIXTURE_URL);
      await waitReady(host.page);

      const uploadRes = await uploadPromise;
      expect(uploadRes.ok()).toBe(true);

      await viewer.page.goto('/rooms');
      const card = viewer.page.getByRole('button', { name: /Sala com Preview/ });
      await expect(card).toBeVisible();

      const previewImg = card.locator('img').first();
      await expect(previewImg).toBeVisible();
      await expect(previewImg).toHaveAttribute('src', new RegExp(`^/api/rooms/${code}/preview\\?v=\\d+$`));
      await expect
        .poll(
          () => previewImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
          { timeout: 15_000 }
        )
        .toBe(true);
    } finally {
      await host.context.close();
      await viewer.context.close();
    }
  });

  test('clicar no card abre o modal de detalhes e Entrar na sala conecta o segundo usuário', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    try {
      const code = await createEmptyRoom(host.page, {
        username: 'Ana',
        roomName: 'Clube do Filme',
        visibility: 'public',
      });

      await guest.page.goto('/rooms');
      const card = guest.page.getByRole('button', { name: /Clube do Filme/ });
      await expect(card).toBeVisible();
      await card.click();

      const dialog = guest.page.getByRole('dialog', { name: 'Clube do Filme' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { level: 2, name: 'Clube do Filme' })).toBeVisible();
      await expect(dialog.getByText(`/room/${code}`)).toBeVisible();
      await expect(dialog.getByText('Pública')).toBeVisible();
      await expect(dialog.getByText('Host')).toBeVisible();
      await expect(dialog.getByText('Ana').first()).toBeVisible();
      await expect(dialog.getByText('Aguardando mídia')).toBeVisible();
      await expect(dialog.getByText('1 pessoa')).toBeVisible();

      await dialog.getByRole('button', { name: 'Entrar na sala' }).click();
      await submitName(guest.page, 'Clara');

      await expect(guest.page).toHaveURL(new RegExp(`/room/${code}$`));
      await expect(guest.page.locator('#room-member-grid')).toContainText('Ana');
      await expect(guest.page.locator('#room-member-grid')).toContainText('Clara');
      await expect(host.page.locator('#room-member-grid')).toContainText('Clara');
    } finally {
      await host.context.close();
      await guest.context.close();
    }
  });
});
