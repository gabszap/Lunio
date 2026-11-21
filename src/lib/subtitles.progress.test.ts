import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./access', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from './access';
import { observeSubtitlePreparation } from './subtitleProgress';

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
describe('selected subtitle observation', () => {
  it('polls every second and stops both timers and pending responses on abort', async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    vi.mocked(apiFetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = new AbortController();
    const status = vi.fn();
    observeSubtitlePreparation('/api/subtitle?url=opaque&track=3', status, first.signal);
    expect(apiFetch).toHaveBeenCalledWith('/api/subtitle?url=opaque&track=3&status=1', expect.anything());
    first.abort();
    finish(Response.json({ stage: 'extracting', updatedAt: 1 }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(status).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
  it('keeps observers independent, ignores server ready and tolerates failures', async () => {
    vi.useFakeTimers();
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Response.json({ stage: 'waiting_cdn', updatedAt: 1, retryAt: 2000 }));
    const first = new AbortController();
    const second = new AbortController();
    const a = vi.fn();
    const b = vi.fn();
    observeSubtitlePreparation('/api/subtitle?track=3', a, first.signal);
    const stop = observeSubtitlePreparation('/api/subtitle?track=3', b, second.signal);
    first.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith({ stage: 'waiting_cdn', updatedAt: 1, retryAt: 2000 });
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ stage: 'ready', updatedAt: 2 }));
    b.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(b).not.toHaveBeenCalled();
    stop();
    const count = vi.mocked(apiFetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(apiFetch).toHaveBeenCalledTimes(count);
  });
  it('does not poll external subtitles', () => {
    observeSubtitlePreparation('https://sub.test/movie.vtt', vi.fn(), new AbortController().signal)();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
