import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '', requested: [] as string[] }));
vi.mock('../media/paths', () => ({ get SUB_CACHE_DIR() { return state.dir; } }));
vi.mock('../cleanup', () => ({ touchCacheFile: vi.fn() }));
vi.mock('../routes/linkParam', () => ({ urlParam: () => 'https://fixture.test/video.mkv', sharedFingerprint: () => 'ih:prefetch|file:0' }));
vi.mock('../media/resolver', () => ({ resolveFinalCdnUrl: async (url: string) => url }));
vi.mock('../tools', () => ({ ffmpegBin: () => 'ffmpeg' }));
vi.mock('../limits', () => ({ spawnLimited: () => {
  const proc = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
  queueMicrotask(() => {
    proc.stderr.emit('data', Buffer.from("Input #0, matroska,webm, from 'video.mkv':\n  Duration: 00:00:10.00, start: 0.000000\n  Stream #0:3(por): Subtitle: ass\n"));
    proc.emit('close', 1);
  });
  return proc;
} }));
vi.mock('../media/subtitles', () => ({ getOrExtractSubtitle: async (_url: string, track: string) => { state.requested.push(track); return ''; } }));

import { handleTracks } from '../routes/tracks';
import { getMediaFingerprint } from '../media/fingerprint';
import { subtitleCachePath, writeCachedSubtitle } from '../media/subtitleCache';
import { tracksCache } from '../media/tracks';

describe('track prefetch shares validated subtitle cache', () => {
  const key = getMediaFingerprint('https://fixture.test/video.mkv', 'ih:prefetch|file:0');
  beforeEach(() => {
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-prefetch-')); state.requested = [];
    tracksCache.delete('https://fixture.test/video.mkv');
  });
  afterEach(() => fs.rmSync(state.dir, { recursive: true, force: true }));
  it.each(['valid', 'corrupt', 'legacy'])('prefetches only when %s disk content is not a validated envelope', async kind => {
    const ass = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Text\n';
    if (kind === 'legacy') fs.writeFileSync(path.join(state.dir, `${key}_s3.ass`), ass);
    else writeCachedSubtitle(key, '3', ass, 'native-ass');
    if (kind === 'corrupt') fs.writeFileSync(subtitleCachePath(key, '3'), '{');
    await new Promise<void>(resolve => {
      const res = { setHeader: vi.fn(), end: resolve } as unknown as ServerResponse;
      void handleTracks({ url: '/api/tracks' } as IncomingMessage, res);
    });
    expect(state.requested).toEqual(kind === 'valid' ? [] : ['3']);
  });
});
