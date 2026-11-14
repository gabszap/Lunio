import type { SubtitlePreparationStage, SubtitlePreparationStatus } from '../../types/media';
import { readCachedSubtitle } from './subtitleCache';

export type { SubtitlePreparationStage, SubtitlePreparationStatus } from '../../types/media';
type ServerStage = Exclude<SubtitlePreparationStage, 'loading_fonts' | 'initializing_renderer'>;
interface ProgressDetails { retryAt?: number; errorCode?: string; active?: boolean }
interface Entry { status: SubtitlePreparationStatus; active: boolean }
const safeErrorCodes = new Set([
  'EXTRACTION_FAILED', 'UPSTREAM_RATE_LIMITED', 'BITMAP_NOT_SUPPORTED', 'SUBTITLE_INVALID',
  'LOCAL_SUBTITLE_CONVERSION_FAILED', 'SUBTITLE_CACHE_FAILED', 'busy', 'url_blocked',
]);

/** Observation records have their own bound; admission never controls the actual job. */
export class SubtitleProgressStore {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly limit = 1000, private readonly ttlMs = 600_000, private readonly now = Date.now) {}

  private prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (!entry.active && now - entry.status.updatedAt >= this.ttlMs) this.entries.delete(key);
    }
  }

  set(mediaKey: string, track: string, stage: ServerStage, details: ProgressDetails = {}): boolean {
    this.prune();
    const key = `${mediaKey}_${track}`;
    if (!this.entries.has(key) && this.entries.size >= this.limit) {
      let oldest: string | undefined;
      let oldestAt = Infinity;
      for (const [candidate, entry] of this.entries) {
        if (!entry.active && entry.status.updatedAt < oldestAt) { oldest = candidate; oldestAt = entry.status.updatedAt; }
      }
      if (oldest === undefined) return false;
      this.entries.delete(oldest);
    }
    const status: SubtitlePreparationStatus = { stage, updatedAt: this.now() };
    if (Number.isFinite(details.retryAt)) status.retryAt = details.retryAt;
    if (details.errorCode) status.errorCode = safeErrorCodes.has(details.errorCode) ? details.errorCode : 'EXTRACTION_FAILED';
    const active = details.active ?? (stage !== 'ready' && stage !== 'failed' && stage !== 'idle');
    this.entries.set(key, { status, active });
    return true;
  }

  get(mediaKey: string, track: string): SubtitlePreparationStatus | undefined {
    this.prune();
    const entry = this.entries.get(`${mediaKey}_${track}`);
    return entry ? { ...entry.status } : undefined;
  }
}

export const subtitleProgress = new SubtitleProgressStore();

/** Reads disk/memory only. An unknown observer never allocates a job or resolves the origin. */
export function getSubtitlePreparationStatus(mediaKey: string, track: string): SubtitlePreparationStatus {
  const status = subtitleProgress.get(mediaKey, track);
  if (readCachedSubtitle(mediaKey, track) !== null) {
    return status?.stage === 'ready' ? status : { stage: 'ready', updatedAt: Date.now() };
  }
  return status && status.stage !== 'ready' ? status : { stage: 'idle', updatedAt: Date.now() };
}
