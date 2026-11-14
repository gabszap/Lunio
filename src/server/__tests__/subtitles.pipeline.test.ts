import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  dir: '', codec: 'ass', content: '', nativeError: '', remoteExit: 0, hold: false,
  calls: [] as string[][], releases: [] as (() => void)[],
}));
vi.mock('../media/paths', () => ({ get SUB_CACHE_DIR() { return state.dir; } }));
vi.mock('../config', () => ({ config: { allowPrivateUrls: true, rootDir: process.cwd() } }));
vi.mock('../cleanup', () => ({ touchCacheFile: vi.fn() }));
vi.mock('../media/fonts', () => ({ warmFonts: vi.fn() }));
vi.mock('../media/ffmpegSpeed', () => ({ ffmpegMbpsFor: () => 10, recordFfmpegRead: vi.fn() }));
vi.mock('../media/resolver', () => ({ resolveFinalCdnUrl: async (url: string) => url }));
vi.mock('../media/tracks', () => ({ tracksCache: { get: () => ({ container: 'matroska', subtitles: [{ index: 3, codec: state.codec }] }) } }));
vi.mock('../media/uploads', () => ({ isInternalUploadUrl: () => false }));
vi.mock('../tools', () => ({ getTools: () => ({ python: { found: true, command: 'python', args: [] } }), ffmpegBin: () => 'ffmpeg', killTree: vi.fn() }));
vi.mock('../limits', () => ({ spawnLimited: (command: string, args: string[]) => {
  state.calls.push([command, ...args]);
  const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const finish = () => {
    if (command === 'python' && state.nativeError) {
      proc.stderr.emit('data', Buffer.from(state.nativeError));
      proc.emit('close', state.nativeError.includes('[FatalError]') ? 1 : 2);
      return;
    }
    const file = command === 'python' ? args[args.indexOf('-o') + 1] : args.at(-1)!;
    fs.writeFileSync(file, command === 'python' && state.codec === 'subrip' ? '1\n00:00:01,000 --> 00:00:02,000\nOlá mundo!\n' : state.content);
    if (command === 'python') proc.stdout.emit('data', Buffer.from(JSON.stringify({ output_file: file, format: state.codec === 'subrip' ? 'srt' : 'ass', coverage: 'verified' })));
    proc.emit('close', command === 'python' ? 0 : state.remoteExit);
  };
  if (state.hold) state.releases.push(finish);
  else queueMicrotask(finish);
  return proc;
} }));

import { getOrExtractSubtitle } from '../media/subtitles';
import { getMediaFingerprint } from '../media/fingerprint';
import { readCachedSubtitle, subtitleCachePath, writeCachedSubtitle } from '../media/subtitleCache';
import { getSubtitlePreparationStatus } from '../media/subtitleProgress';
import { noteRateLimited, resetGateForTests, runOnHost } from '../media/upstreamGate';
import { handleSubtitle } from '../routes/subtitle';

const ass = '[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Olá, mundo!\n';
let serial = 0;
describe('subtitle pipeline publication and progress', () => {
  let url: string;
  let key: string;
  const status = () => getSubtitlePreparationStatus(key, '3');
  const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  beforeEach(() => {
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-pipeline-'));
    state.codec = 'ass'; state.content = ass; state.nativeError = ''; state.remoteExit = 0;
    state.hold = false; state.calls = []; state.releases = [];
    url = `https://fixture.test/${++serial}.mkv?token=secret`;
    key = getMediaFingerprint(url);
    resetGateForTests();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(state.dir, { recursive: true, force: true }); });

  it('publishes an envelope and reuses it with rotated tokens without spawning producers', async () => {
    expect(await getOrExtractSubtitle(url, '3')).toBe(ass);
    expect(readCachedSubtitle(key, '3')).toBe(ass);
    expect(status().stage).toBe('ready');
    expect(await getOrExtractSubtitle(url.replace('secret', 'rotated'), '3')).toBe(ass);
    expect(state.calls).toHaveLength(1);
    expect(fs.readdirSync(state.dir)).toEqual([`${key}_s3_v2.json`]);
  });

  it('reextracts a corrupt cache once while sharing the job', async () => {
    writeCachedSubtitle(key, '3', ass, 'native-ass');
    fs.writeFileSync(subtitleCachePath(key, '3'), '{');
    const [a, b] = await Promise.all([getOrExtractSubtitle(url, '3'), getOrExtractSubtitle(url, '3')]);
    expect(a).toBe(ass); expect(b).toBe(ass);
    expect(state.calls).toHaveLength(1);
  });

  it('does not retry the origin for invalid native ASS', async () => {
    state.content = '<html>' + 'error'.repeat(100);
    await expect(getOrExtractSubtitle(url, '3')).rejects.toMatchObject({ code: 'SUBTITLE_INVALID' });
    expect(state.calls).toHaveLength(1);
    expect(status()).toMatchObject({ stage: 'failed', errorCode: 'SUBTITLE_INVALID' });
    expect(fs.readdirSync(state.dir)).toEqual([]);
  });

  it('does not retry the origin when publishing the cache fails', async () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('private C:\\cache\\file'); });
    await expect(getOrExtractSubtitle(url, '3')).rejects.toMatchObject({ code: 'SUBTITLE_CACHE_FAILED' });
    expect(state.calls).toHaveLength(1);
    expect(status()).toMatchObject({ stage: 'failed', errorCode: 'SUBTITLE_CACHE_FAILED' });
    expect(fs.readdirSync(state.dir)).toEqual([]);
  });

  it.each([
    ['[FatalError] PermissionError: cannot write C:\\private\\subtitle.ass', 'SUBTITLE_CACHE_FAILED'],
    ['[FatalError] UnicodeDecodeError: invalid subtitle text', 'SUBTITLE_INVALID'],
  ])('does not retry the origin for a local producer failure: %s', async (error, code) => {
    state.nativeError = error;
    await expect(getOrExtractSubtitle(url, '3')).rejects.toMatchObject({ code });
    expect(state.calls).toHaveLength(1);
    expect(status()).toMatchObject({ stage: 'failed', errorCode: code });
  });

  it.each([1, null])('requires FFmpeg code zero even when a complete valid ASS exists (exit %s)', async code => {
    state.codec = 'mov_text'; state.remoteExit = code as number;
    await expect(getOrExtractSubtitle(url, '3')).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' });
    expect(readCachedSubtitle(key, '3')).toBeNull();
    expect(fs.readdirSync(state.dir)).toEqual([]);
  });

  it('validates and publishes remote FFmpeg output after exit zero', async () => {
    state.codec = 'mov_text';
    expect(await getOrExtractSubtitle(url, '3')).toBe(ass);
    expect(JSON.parse(fs.readFileSync(subtitleCachePath(key, '3'), 'utf8')).producer).toBe('ffmpeg');
  });

  it('reports queue, extraction, local conversion, and publication for a shared job', async () => {
    state.hold = true; state.codec = 'subrip';
    let releaseGate!: () => void;
    const blocker = runOnHost('fixture.test', 'interactive', () => new Promise<void>(resolve => { releaseGate = resolve; })).promise;
    const first = getOrExtractSubtitle(url, '3', undefined, { prefetch: true });
    const second = getOrExtractSubtitle(url, '3');
    await flush();
    expect(status().stage).toBe('queued');
    releaseGate(); await blocker; await flush();
    expect(status().stage).toBe('extracting');
    expect(state.calls).toHaveLength(1);
    state.releases.shift()!(); await flush();
    expect(status().stage).toBe('converting');
    state.releases.shift()!();
    expect(await first).toBe(ass); expect(await second).toBe(ass);
    expect(status().stage).toBe('ready');
  });

  it('observes cooldown in the gate without starting a producer early', async () => {
    vi.useFakeTimers();
    noteRateLimited('fixture.test', 10);
    const result = getOrExtractSubtitle(url, '3');
    await flush();
    expect(status()).toMatchObject({ stage: 'waiting_cdn', retryAt: Date.now() + 10_000 });
    expect(state.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe(ass);
    expect(status().stage).toBe('ready');
  });

  it('disconnecting one HTTP observer preserves the extraction awaited by another', async () => {
    state.hold = true;
    let requests = 0;
    const server = http.createServer((req, res) => { requests++; void handleSubtitle(req, res); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/subtitle?url=${encodeURIComponent(url)}&track=3`;
    const controller = new AbortController();
    const first = fetch(base, { signal: controller.signal }).catch(error => error);
    try {
      await vi.waitFor(() => expect(state.releases).toHaveLength(1));
      const second = fetch(base);
      await vi.waitFor(() => expect(requests).toBe(2));
      controller.abort();
      expect((await first).name).toBe('AbortError');
      const observation = await fetch(`${base}&status=1`);
      expect(await observation.json()).toMatchObject({ stage: 'extracting' });
      expect(state.calls).toHaveLength(1);
      state.releases.shift()!();
      const response = await second;
      expect(response.headers.get('x-subtitle-format')).toBe('ass');
      expect(await response.text()).toBe(ass);
      expect(status().stage).toBe('ready');
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('reports retryAt during 429 retries and a sanitized terminal CDN wait without FFmpeg fallback', async () => {
    vi.useFakeTimers();
    state.nativeError = '[HttpStatus] 429 retry-after=15\n[FallbackReason] http_transport_error';
    const result = getOrExtractSubtitle(url, '3');
    const rejected = expect(result).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED' });
    await flush();
    expect(status()).toMatchObject({ stage: 'waiting_cdn', retryAt: Date.now() + 15_000, errorCode: 'UPSTREAM_RATE_LIMITED' });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(state.calls).toHaveLength(3);
    expect(state.calls.every(call => call[0] === 'python')).toBe(true);
    expect(status()).toMatchObject({ stage: 'waiting_cdn', errorCode: 'UPSTREAM_RATE_LIMITED' });
    expect(status().retryAt).toBe(Date.now() + 15_000);
  });
});
