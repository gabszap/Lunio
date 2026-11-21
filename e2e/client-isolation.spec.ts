import { expect, test } from '@playwright/test';
import { newUser, testClientHeaders } from './helpers';

test('a cota de sessões de um cliente não bloqueia outro contexto', async ({ browser }) => {
  const busy = await newUser(browser);
  const next = await newUser(browser);
  try {
    for (let i = 0; i < 30; i++) {
      const response = await busy.context.request.post('/api/session', { headers: testClientHeaders(busy.context) });
      expect(response.status()).toBe(200);
    }
    await busy.page.goto('/api/status');
    const limited = await busy.page.evaluate(async () => (await fetch('/api/session', { method: 'POST' })).status);
    expect(limited).toBe(429);

    const other = await next.context.request.post('/api/session', { headers: testClientHeaders(next.context) });
    expect(other.status()).toBe(200);
  } finally {
    await busy.context.close();
    await next.context.close();
  }
});
