import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ cache: '', root: process.cwd(), codecs: 'ass', calls: [] as string[][], pythonFailure: '', conversionFails: false }));
vi.mock('../media/paths', () => ({ get SUB_CACHE_DIR() { return state.cache; } }));
vi.mock('../config', () => ({ config: { allowPrivateUrls: true, get rootDir() { return state.root; } } }));
vi.mock('../cleanup', () => ({ touchCacheFile: vi.fn() }));
vi.mock('../media/fonts', () => ({ warmFonts: vi.fn() }));
vi.mock('../media/resolver', () => ({ resolveFinalCdnUrl: async (url: string) => url }));
vi.mock('../media/tracks', () => ({ tracksCache: { get: () => ({ container: 'matroska,webm', subtitles: [{ index: 0, codec: state.codecs }] }) } }));
vi.mock('../media/uploads', () => ({ isInternalUploadUrl: () => false }));
// Use a slow FFmpeg speed that stays nonzero after CLI rounding.
vi.mock('../media/ffmpegSpeed', () => ({ ffmpegMbpsFor: () => 0.1, recordFfmpegRead: vi.fn() }));
vi.mock('../tools', () => ({
  getTools: () => ({ python: { found: true, command: 'python', args: [] } }),
  ffmpegBin: () => 'ffmpeg',
  killTree: (proc: ChildProcess) => proc.kill(),
}));
vi.mock('../limits', () => ({ spawnLimited: (command: string, args: string[], options: object) => {
  state.calls.push([command, ...args]);
  if (command === 'python' && state.pythonFailure) return spawn('python', ['-c', `import sys; sys.stderr.write('[FallbackReason] ${state.pythonFailure}\\n'); sys.exit(2)`]);
  if (command !== 'python' && state.conversionFails && !/^https?:/.test(args[args.indexOf('-i') + 1])) return spawn('python', ['-c', 'import sys; sys.exit(1)']);
  if (command !== 'python' && /^https?:/.test(args[args.indexOf('-i') + 1])) throw new Error('Unexpected remote FFmpeg fallback');
  return spawn(command, args, options);
} }));
vi.mock('../media/upstreamGate', () => ({
  hostOf: () => 'fixture', cooldownRemainingMs: () => 0, noteRateLimited: vi.fn(),
  runOnHost: (_host: string, _priority: string, job: () => Promise<string>) => ({ promise: job(), bump: vi.fn() }),
}));

import { getOrExtractSubtitle } from '../media/subtitles';

describe('native subtitle extraction through the real Python CLI', () => {
  let fixture: ChildProcess;
  let srtFixture: ChildProcess;
  let url: string;
  let srtUrl: string;
  beforeAll(async () => {
    state.cache = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-native-sub-'));
    fixture = spawn('python', ['-u', 'tests/serve_mkv_fixture.py'], { cwd: state.root });
    let buffer = '';
    url = await new Promise<string>((resolve, reject) => {
      fixture.on('error', reject);
      fixture.stderr?.on('data', d => reject(new Error(d.toString())));
      fixture.stdout?.on('data', d => {
        buffer += d.toString();
        if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0]).url);
      });
    });
    srtFixture = spawn('python', ['-u', 'tests/serve_mkv_fixture.py', 'S_TEXT/UTF8'], { cwd: state.root });
    srtUrl = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      srtFixture.on('error', reject);
      srtFixture.stderr?.on('data', d => reject(new Error(d.toString())));
      srtFixture.stdout?.on('data', d => {
        buffer += d.toString();
        if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0]).url.replace('fixture.mkv', 'opaque'));
      });
    });
  });
  beforeEach(() => { state.calls.length = 0; state.pythonFailure = ''; state.conversionFails = false; });
  afterAll(async () => {
    for (const proc of [fixture, srtFixture]) {
      if (proc && proc.exitCode === null) {
        const closed = once(proc, 'close');
        proc.kill();
        await closed;
      }
    }
    if (state.cache) fs.rmSync(state.cache, { recursive: true, force: true });
  });

  it('uses an ASS-compatible temporary and publishes native ASS without fallback', async () => {
    const content = await getOrExtractSubtitle(url, '0');
    expect(content).toContain('[Script Info]');
    expect(content).toContain('Olá integração!');
    const python = state.calls.find(args => args[0] === 'python')!;
    expect(python[python.indexOf('-o') + 1]).toMatch(/\.tmp\.ass$/);
    expect(state.calls).toHaveLength(1);
    expect(fs.readdirSync(state.cache)).toHaveLength(1);
    expect(fs.readdirSync(state.cache)[0]).toMatch(/_s0_v2\.json$/);
    expect(JSON.parse(fs.readFileSync(path.join(state.cache, fs.readdirSync(state.cache)[0]), 'utf8'))).toMatchObject({ version: 2, format: 'ass', producer: 'native-ass', content });
  });

  it('extracts SRT from confirmed MKV with an opaque URL and converts only the local file to ASS', async () => {
    state.codecs = 'subrip';
    const content = await getOrExtractSubtitle(srtUrl, '0');
    expect(content).toContain('[Script Info]');
    expect(content).toContain('Olá, mundo!');
    expect(content).toContain('0:00:00.90,0:00:01.60');
    expect(state.calls).toHaveLength(2);
    const python = state.calls[0];
    expect(python[python.indexOf('-o') + 1]).toMatch(/\.tmp\.srt$/);
    const ffmpeg = state.calls[1];
    expect(ffmpeg[ffmpeg.indexOf('-i') + 1]).toMatch(/\.tmp\.srt$/);
    expect(ffmpeg[ffmpeg.indexOf('-i') + 1]).not.toMatch(/^https?:/);
    expect(fs.readdirSync(state.cache).every(name => name.endsWith('_v2.json'))).toBe(true);
  });

  it('propagates url_blocked without a remote FFmpeg fallback or retry', async () => {
    state.codecs = 'ass';
    state.pythonFailure = 'url_blocked';
    await expect(getOrExtractSubtitle(url, '0', 'blocked-native')).rejects.toMatchObject({ code: 'url_blocked' });
    expect(state.calls).toHaveLength(1);
  });

  it('does not restart a remote download when local conversion fails', async () => {
    state.codecs = 'subrip';
    state.conversionFails = true;
    await expect(getOrExtractSubtitle(srtUrl, '0', 'conversion-failed')).rejects.toMatchObject({ code: 'LOCAL_SUBTITLE_CONVERSION_FAILED' });
    expect(state.calls).toHaveLength(2);
    expect(fs.readdirSync(state.cache).some(name => name.includes('.tmp'))).toBe(false);
  });
});
