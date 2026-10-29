import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../access', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.useFakeTimers();
  apiFetch.mockReset();
  vi.resetModules();
});
afterEach(() => vi.useRealTimers());

describe('fetchToken', () => {
  it('POSTs to /api/screen/token and returns the answer', async () => {
    const body = { url: 'https://relay.test/SECRET', path: 'lunio/S/abc', publish: false, quality: '1080p60', sessionId: 'ff' };
    apiFetch.mockResolvedValue(json(200, body));
    const { screenApi } = await import('./api');
    await expect(screenApi.fetchToken()).resolves.toEqual(body);
    expect(apiFetch).toHaveBeenCalledWith('/api/screen/token', { method: 'POST' });
  });

  it.each([
    [503, 'screenshare_disabled', /desligada|turned off/i],
    [404, 'no_screen', /não há transmissão|no screen share/i],
    [409, 'screen_not_live', /ainda não começou|not started/i],
  ])('%i %s becomes a readable error without leaking the URL', async (status, code, text) => {
    apiFetch.mockResolvedValue(json(status, { error: 'x', code, url: 'https://relay.test/SECRET' }));
    const { screenApi } = await import('./api');
    const err = (await screenApi.fetchToken().catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(text);
    expect(err.message).not.toContain('SECRET');
  });

  it('a network failure or an unreadable body is a generic error', async () => {
    apiFetch.mockRejectedValue(new Error('net down'));
    const { screenApi } = await import('./api');
    await expect(screenApi.fetchToken()).rejects.toThrow();
    apiFetch.mockResolvedValue(new Response('<html>', { status: 200 }));
    await expect(screenApi.fetchToken()).rejects.toThrow();
  });
});

describe('isEnabled', () => {
  it('is true only when the server says screen.enabled === true, and caches for 60 s', async () => {
    apiFetch.mockResolvedValue(json(200, { screen: { enabled: true } }));
    const { screenApi } = await import('./api');
    expect(await screenApi.isEnabled()).toBe(true);
    expect(await screenApi.isEnabled()).toBe(true);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61_000);
    await screenApi.isEnabled();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('is false for a disabled server, a missing field and a failing request', async () => {
    const { screenApi } = await import('./api');
    apiFetch.mockResolvedValueOnce(json(200, { screen: { enabled: false } }));
    expect(await screenApi.isEnabled()).toBe(false);
    await vi.advanceTimersByTimeAsync(61_000);
    apiFetch.mockResolvedValueOnce(json(200, {}));
    expect(await screenApi.isEnabled()).toBe(false);
    await vi.advanceTimersByTimeAsync(61_000);
    apiFetch.mockRejectedValueOnce(new Error('down'));
    expect(await screenApi.isEnabled()).toBe(false);
  });
});
