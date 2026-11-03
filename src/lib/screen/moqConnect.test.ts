import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitUntilConnected } from './moqTransport';

const signal = <T>(v: { current: T }) => ({ peek: () => v.current });
const noError = () => signal({ current: undefined as Error | undefined });

describe('waitUntilConnected', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves once the connection reports connected', async () => {
    const status = { current: 'connecting' };
    const p = waitUntilConnected(signal(status), noError(), { timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(200);
    status.current = 'connected';
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBeUndefined();
  });

  it('rejects with a generic message (no URL) when it never connects', async () => {
    const p = waitUntilConnected(signal({ current: 'connecting' }), noError(), { timeoutMs: 1000 });
    const caught = p.catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(1200);
    const err = (await caught) as Error;
    expect(err.message).toMatch(/conectar/i);
    expect(err.message).not.toMatch(/https?:/);
  });

  it('rejects at once when the signal is aborted', async () => {
    const ctl = new AbortController();
    const p = waitUntilConnected(signal({ current: 'connecting' }), noError(), { timeoutMs: 5000, signal: ctl.signal });
    const caught = p.catch((e) => e as Error);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(((await caught) as Error).message).toMatch(/cancelado/i);
  });
});
