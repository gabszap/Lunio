import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncDiagnostics } from './syncDiagnostics';

describe('diagnóstico da sincronização', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('mede idade monotônica, percentis de drift absoluto e correções aplicadas', () => {
    const diagnostics = new SyncDiagnostics();
    diagnostics.markTimeline();
    diagnostics.setRtt(60);
    diagnostics.recordState('playing');
    diagnostics.recordDrift({ drift: -1.4, action: 'seek', targetTime: 30 }, 1.5);
    diagnostics.recordDrift({ drift: 0.3, action: 'rate_slowdown', targetTime: 31 }, 1.275);
    diagnostics.recordState('stalled');
    diagnostics.recordState('stalled');
    vi.advanceTimersByTime(800);
    vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));
    diagnostics.recordDrift({ drift: 0.05, action: 'none', targetTime: 32 }, 1.5);

    const snapshot = diagnostics.snapshot();
    expect(snapshot).toMatchObject({
      state: 'stalled', ageMs: 800, rtt: 60, driftMs: 50, rate: 1.5,
      p50Ms: 300, p95Ms: 1400, sampleCount: 3, seeks: 1,
    });
    expect(snapshot.events).toMatchObject([
      { at: Date.parse('2026-11-23T12:00:00Z'), state: 'playing' },
      { action: 'seek', driftMs: -1400 },
      { action: 'rate_slowdown', driftMs: 300 },
      { state: 'stalled' },
      { action: 'none', driftMs: 50 },
    ]);
  });

  it('limita o histórico e reinicia as medições com a mídia ou conexão nova', () => {
    const diagnostics = new SyncDiagnostics();
    diagnostics.setRtt(60);
    diagnostics.markTimeline();
    for (let i = 0; i < 950; i++) {
      diagnostics.recordDrift({ drift: -2, action: 'seek', targetTime: i }, 1);
    }
    expect(diagnostics.snapshot()).toMatchObject({ sampleCount: 900, seeks: 950 });
    expect(diagnostics.snapshot().events).toHaveLength(30);

    diagnostics.resetMedia();
    expect(diagnostics.snapshot()).toMatchObject({ sampleCount: 0, seeks: 0, events: [], rtt: 60, ageMs: undefined, driftMs: undefined });
    diagnostics.resetConnection();
    expect(diagnostics.snapshot().rtt).toBeUndefined();
  });
});
