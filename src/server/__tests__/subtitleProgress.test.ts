import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('../media/paths', () => ({ get SUB_CACHE_DIR() { return state.dir; } }));
vi.mock('../cleanup', () => ({ touchCacheFile: vi.fn() }));
import { SubtitleProgressStore, getSubtitlePreparationStatus, subtitleProgress } from '../media/subtitleProgress';
import { writeCachedSubtitle } from '../media/subtitleCache';

describe('subtitle progress observations', () => {
  let now: number;
  beforeEach(() => { now = 1000; state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-progress-')); });
  afterEach(() => fs.rmSync(state.dir, { recursive: true, force: true }));

  it('reports real transitions and returns snapshots without private details', () => {
    const store = new SubtitleProgressStore(1000, 600_000, () => now);
    for (const stage of ['queued', 'extracting', 'converting', 'ready'] as const) {
      store.set('abc', '3', stage);
      expect(store.get('abc', '3')).toEqual({ stage, updatedAt: now });
      now++;
    }
    const snapshot = store.get('abc', '3')!;
    snapshot.stage = 'failed';
    expect(store.get('abc', '3')?.stage).toBe('ready');
    store.set('abc', '3', 'failed', { errorCode: 'https://cdn.test/?token=secret C:\\private\\sub.ass' });
    expect(store.get('abc', '3')).toEqual({ stage: 'failed', updatedAt: now, errorCode: 'EXTRACTION_FAILED' });
  });

  it('keeps CDN deadlines and clears them when extraction resumes', () => {
    const store = new SubtitleProgressStore(1000, 600_000, () => now);
    store.set('abc', '3', 'waiting_cdn', { retryAt: 16_000, errorCode: 'UPSTREAM_RATE_LIMITED' });
    expect(store.get('abc', '3')).toEqual({ stage: 'waiting_cdn', updatedAt: 1000, retryAt: 16_000, errorCode: 'UPSTREAM_RATE_LIMITED' });
    store.set('abc', '3', 'extracting');
    expect(store.get('abc', '3')).toEqual({ stage: 'extracting', updatedAt: 1000 });
  });

  it('expires terminal states without refreshing TTL on observation and preserves active jobs', () => {
    const store = new SubtitleProgressStore(1000, 600_000, () => now);
    store.set('abc', '1', 'queued');
    store.set('abc', '2', 'failed', { errorCode: 'SUBTITLE_INVALID' });
    store.set('abc', '3', 'waiting_cdn', { retryAt: 2000, active: false });
    now += 599_999;
    expect(store.get('abc', '2')?.stage).toBe('failed');
    now++;
    expect(store.get('abc', '2')).toBeUndefined();
    expect(store.get('abc', '3')).toBeUndefined();
    expect(store.get('abc', '1')?.stage).toBe('queued');
  });

  it('evicts oldest terminals at capacity, refuses new observations when all jobs are active', () => {
    const store = new SubtitleProgressStore(1000, 600_000, () => now);
    store.set('abc', '0', 'ready');
    for (let i = 1; i < 1000; i++) store.set('abc', String(i), 'extracting');
    expect(store.set('def', '0', 'queued')).toBe(true);
    expect(store.get('abc', '0')).toBeUndefined();
    expect(store.set('def', '1', 'queued')).toBe(false);
    expect(store.get('def', '1')).toBeUndefined();
    now += 1_000_000;
    expect(store.get('abc', '1')?.stage).toBe('extracting');
    expect(store.set('abc', '1', 'ready')).toBe(true);
    expect(store.set('def', '1', 'queued')).toBe(true);
  });

  it('looks up disk cache without registering unknown jobs and ignores stale ready states', () => {
    expect(getSubtitlePreparationStatus('abcdef', '3')).toMatchObject({ stage: 'idle' });
    expect(subtitleProgress.get('abcdef', '3')).toBeUndefined();
    const ass = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Text\n';
    writeCachedSubtitle('abcdef', '3', ass, 'native-ass');
    expect(getSubtitlePreparationStatus('abcdef', '3')).toMatchObject({ stage: 'ready' });
    fs.rmSync(state.dir, { recursive: true });
    subtitleProgress.set('abcdef', '3', 'ready');
    expect(getSubtitlePreparationStatus('abcdef', '3')).toMatchObject({ stage: 'idle' });
  });
});
