import type { MemberPlaybackState } from '../types/sync';
import type { DriftCorrectionResult } from './playbackDrift';

const MAX_SAMPLES = 900;
const MAX_EVENTS = 30;

type DiagnosticEvent =
  | { at: number; state: MemberPlaybackState }
  | { at: number; action: DriftCorrectionResult['action']; driftMs: number };

export class SyncDiagnostics {
  private absoluteDrifts: number[] = [];
  private events: DiagnosticEvent[] = [];
  private lastTimelineAt?: number;
  private rtt?: number;
  private state?: MemberPlaybackState;
  private driftMs?: number;
  private action?: DriftCorrectionResult['action'];
  private rate?: number;
  private seeks = 0;

  markTimeline() {
    this.lastTimelineAt = performance.now();
  }

  setRtt(rtt: number) {
    this.rtt = rtt;
  }

  recordState(state: MemberPlaybackState) {
    if (state === this.state) return;
    this.state = state;
    this.pushEvent({ at: Date.now(), state });
  }

  recordDrift({ drift, action }: DriftCorrectionResult, appliedRate: number) {
    if (!Number.isFinite(drift)) return;
    this.driftMs = Math.round(drift * 1000);
    this.rate = appliedRate;
    this.absoluteDrifts.push(Math.abs(this.driftMs));
    if (this.absoluteDrifts.length > MAX_SAMPLES) this.absoluteDrifts.shift();

    if (action === 'seek') this.seeks++;
    if (action === 'seek' || action !== this.action) {
      this.pushEvent({ at: Date.now(), action, driftMs: this.driftMs });
    }
    this.action = action;
  }

  private pushEvent(event: DiagnosticEvent) {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  resetConnection() {
    this.rtt = undefined;
    this.lastTimelineAt = undefined;
  }

  resetMedia() {
    this.absoluteDrifts = [];
    this.events = [];
    this.lastTimelineAt = undefined;
    this.state = undefined;
    this.driftMs = undefined;
    this.action = undefined;
    this.rate = undefined;
    this.seeks = 0;
  }

  snapshot() {
    const sorted = [...this.absoluteDrifts].sort((a, b) => a - b);
    return {
      driftMs: this.driftMs,
      rtt: this.rtt,
      ageMs: this.lastTimelineAt === undefined ? undefined : performance.now() - this.lastTimelineAt,
      rate: this.rate,
      state: this.state,
      seeks: this.seeks,
      sampleCount: sorted.length,
      p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      events: [...this.events],
    };
  }
}

export const syncDiagnostics = import.meta.env.DEV ? new SyncDiagnostics() : undefined;
