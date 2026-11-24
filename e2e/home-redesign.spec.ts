import { expect, test } from '@playwright/test';
import { createEmptyRoom, newUser, submitName } from './helpers';

test.describe('Redesign da Home e criação de sala vazia', () => {
  test('exibe hero, pílula de presença e cápsula do topo com Salas em breve', async ({ browser }) => {
    const { context, page } = await newUser(browser);
    try {
      // Sem pessoas online: pílula usa fallback padrão
      await page.route('**/api/presence', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: 0, people: 0 }) })
      );
      await page.goto('/');

      await expect(page.getByRole('heading', { level: 1, name: /Assista junto com a galera/ })).toBeVisible();
      await expect(page.getByText('Grátis · direto do navegador')).toBeVisible();

      const nav = page.getByRole('tablist', { name: 'Navegação principal' });
      await expect(nav.getByRole('tab', { name: 'Início', selected: true })).toBeVisible();
      await expect(nav.getByRole('tab', { name: 'Catálogo' })).toBeEnabled();
      await expect(nav.getByRole('tab', { name: 'Status' })).toBeEnabled();

      const salasBtn = nav.getByRole('button', { name: /Salas/ });
      await expect(salasBtn).toBeDisabled();
      await expect(salasBtn).toContainText('Em breve');

      // Com pessoas online: pílula mostra contagem real
      await page.unroute('**/api/presence');
      await page.route('**/api/presence', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: 2, people: 5 }) })
      );
      await page.reload();
      await expect(page.getByText(/5\s+pessoas utilizando o Lunio/)).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('edição inline de apelido salva na Home e pula o UsernameModal ao criar sala', async ({ browser }) => {
    const { context, page } = await newUser(browser);
    try {
      await page.goto('/');
      await expect(page.getByText('Sem apelido definido')).toBeVisible();

      await page.getByRole('button', { name: 'Definir nome' }).click();
      await page.getByLabel('Seu apelido na sala').fill('Marina');
      await page.getByRole('button', { name: 'Salvar' }).click();

      await expect(page.getByText(/Usando nome\s+Marina/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Trocar' })).toBeVisible();

      // Troca o nome inline novamente antes de criar a sala
      await page.getByRole('button', { name: 'Trocar' }).click();
      await page.getByLabel('Seu apelido na sala').fill('Lucas');
      await page.getByRole('button', { name: 'Salvar' }).click();
      await expect(page.getByText(/Usando nome\s+Lucas/)).toBeVisible();

      // Cria a sala sem exibir o UsernameModal
      await page.getByLabel('Nome da sala').fill('Noite do Filme');
      await page.getByRole('button', { name: 'Criar sala', exact: true }).click();

      await expect(page.getByText('Como você quer ser chamado?')).toHaveCount(0);
      await expect(page).toHaveURL(/\/room\/[A-Z0-9]+/);
      await expect(page.locator('#room-member-grid')).toContainText('Lucas');
    } finally {
      await context.close();
    }
  });

  test('validação de nome obrigatório bloqueia criação sem nome e mostra aviso inline', async ({ browser }) => {
    const { context, page } = await newUser(browser);
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'Criar sala', exact: true }).click();

      await expect(page).not.toHaveURL(/\/room\/|room=/);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const roomNameInput = page.getByLabel('Nome da sala');
      await expect(roomNameInput).toBeFocused();
      await expect(roomNameInput).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByRole('alert')).toHaveText('Dê um nome para a sala antes de criar.');

      // Preencher um caractere limpa o erro inline
      await roomNameInput.fill('Sala Teste');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(roomNameInput).not.toHaveAttribute('aria-invalid', 'true');
    } finally {
      await context.close();
    }
  });

  test('criar sala pública vazia entra no palco de membros com nome no cabeçalho e abre MediaPickerModal', async ({ browser }) => {
    const { context, page } = await newUser(browser);
    try {
      const code = await createEmptyRoom(page, {
        username: 'Ana',
        roomName: 'Maratona de Anime',
        visibility: 'public',
      });

      await expect(page).toHaveURL(new RegExp(`/room/${code}$`));
      await expect(page.locator('#room-member-grid')).toBeVisible();
      await expect(page.locator('#room-member-grid')).toContainText('Ana');
      await expect(page.locator('video')).toHaveCount(0);

      // Nome da sala aparece no cabeçalho (sem cadeado de privada)
      const header = page.locator('header');
      await expect(header).toContainText('Maratona de Anime');
      await expect(header.getByLabel('Sala privada')).toHaveCount(0);

      // Barra de CTA do Host no palco vazio
      await expect(page.getByText('Nenhum vídeo tocando ainda')).toBeVisible();
      await page.getByRole('button', { name: 'Escolher vídeo' }).click();

      const picker = page.locator('[aria-label="Escolher vídeo"]');
      await expect(picker).toBeVisible();
      for (const tabLabel of ['Catálogo', 'Link de stream', 'Enviar um arquivo', 'YouTube', 'Google Drive']) {
        await expect(picker.getByRole('tab', { name: tabLabel })).toBeVisible();
      }

      await picker.getByRole('button', { name: 'Voltar para a sala' }).first().click();
      await expect(picker).toHaveCount(0);
      await expect(page.locator('#room-member-grid')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('criar sala privada sem senha permite outro usuário entrar só pelo link sem pedir senha', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    try {
      const code = await createEmptyRoom(host.page, {
        username: 'Ana',
        roomName: 'Sessão Fechada',
        visibility: 'private',
      });

      await expect(host.page.locator('header')).toContainText('Sessão Fechada');
      await expect(host.page.locator('header').getByLabel('Sala privada')).toBeVisible();

      await guest.page.goto(`/room/${code}`);
      await submitName(guest.page, 'Bia');

      await expect(guest.page).toHaveURL(new RegExp(`/room/${code}$`));
      await expect(guest.page.getByRole('dialog', { name: 'Sala privada' })).toHaveCount(0);
      await expect(guest.page.locator('#room-member-grid')).toContainText('Ana');
      await expect(guest.page.locator('#room-member-grid')).toContainText('Bia');
      await expect(host.page.locator('#room-member-grid')).toContainText('Bia');
    } finally {
      await host.context.close();
      await guest.context.close();
    }
  });

  test('criar sala privada com senha pede senha, mostra erro ao errar e libera ao acertar', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    try {
      const code = await createEmptyRoom(host.page, {
        username: 'Ana',
        roomName: 'Clube Secreto',
        visibility: 'private',
        password: 'cinema123',
      });

      await guest.page.goto(`/room/${code}`);
      await submitName(guest.page, 'Bia');

      const pwDialog = guest.page.getByRole('dialog', { name: 'Sala privada' });
      await expect(pwDialog).toBeVisible();

      // Senha errada
      await pwDialog.getByPlaceholder('Senha da sala').fill('errada');
      await pwDialog.getByRole('button', { name: 'Entrar na sala' }).click();
      await expect(pwDialog.getByRole('alert')).toHaveText('Senha incorreta. Tente novamente.');
      await expect(pwDialog).toBeVisible();

      // Senha certa
      await pwDialog.getByPlaceholder('Senha da sala').fill('cinema123');
      await pwDialog.getByRole('button', { name: 'Entrar na sala' }).click();

      await expect(pwDialog).toBeHidden();
      await expect(guest.page).toHaveURL(new RegExp(`/room/${code}$`));
      await expect(guest.page.locator('#room-member-grid')).toContainText('Ana');
      await expect(guest.page.locator('#room-member-grid')).toContainText('Bia');
    } finally {
      await host.context.close();
      await guest.context.close();
    }
  });

  test('aba Entrar com código valida entrada, avisa sala inexistente/encerrada e entra em sala ativa', async ({ browser }) => {
    const host = await newUser(browser);
    const guest = await newUser(browser);
    try {
      const code = await createEmptyRoom(host.page, {
        username: 'Ana',
        roomName: 'Sala Ativa',
      });

      await guest.page.goto('/');
      await guest.page.getByRole('tab', { name: 'Entrar com código' }).click();

      const codeInput = guest.page.getByLabel('Link ou código da sala');
      const joinSubmit = guest.page.getByRole('button', { name: 'Entrar na sala', exact: true });

      // Código inválido
      await codeInput.fill('abc');
      await joinSubmit.click();
      await expect(guest.page.getByRole('alert')).toContainText('Isso não parece um código de sala');

      // Sala inexistente
      await codeInput.fill('ZZZZ9999');
      await joinSubmit.click();
      await expect(guest.page.getByRole('alert')).toContainText('Não achamos essa sala');

      // Sala encerrada: exibe tela de sala encerrada com o código e opções de ação
      await guest.page.route('**/api/room?id=FECHADA1', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ exists: false, closed: true, members: 0, hasMedia: false }),
        })
      );
      await codeInput.fill('FECHADA1');
      await joinSubmit.click();
      await expect(guest.page.getByRole('heading', { name: 'Essa sala foi encerrada' })).toBeVisible();
      await expect(guest.page.getByText('FECHADA1')).toBeVisible();
      await guest.page.getByRole('button', { name: 'Entrar em outra' }).click();

      // Sala ativa: entra com sucesso
      await guest.page.getByLabel('Link ou código da sala').fill(code);
      await guest.page.getByRole('button', { name: 'Entrar na sala', exact: true }).click();
      await submitName(guest.page, 'Bia');
      await expect(guest.page).toHaveURL(new RegExp(`/room/${code}$`));
      await expect(guest.page.locator('#room-member-grid')).toContainText('Ana');
      await expect(guest.page.locator('#room-member-grid')).toContainText('Bia');
    } finally {
      await host.context.close();
      await guest.context.close();
    }
  });
});
