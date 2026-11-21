import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('../media/paths', () => ({ get SUB_CACHE_DIR() { return state.dir; } }));
import { readCachedSubtitle, subtitleCachePath, writeCachedSubtitle } from '../media/subtitleCache';
const ass = '[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Olá, mundo!\n';
describe('versioned subtitle cache', () => {
  beforeEach(() => { state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-subcache-')); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(state.dir, { recursive: true, force: true }); });
  it('round-trips validated ASS with identity and digest in a single file', () => {
    writeCachedSubtitle('abc', '3', ass, 'native-ass');
    expect(readCachedSubtitle('abc', '3')).toBe(ass);
    expect(fs.readdirSync(state.dir)).toEqual(['abc_s3_v2.json']);
    expect(JSON.parse(fs.readFileSync(subtitleCachePath('abc', '3'), 'utf8'))).toMatchObject({ version: 2, format: 'ass', events: 1, mediaKey: 'abc', track: '3' });
  });
  it.each(['version', 'identity', 'mediaKey', 'format', 'producer', 'digest', 'count', 'truncated', 'utf8'])('treats corrupt %s entries as misses', (kind) => {
    writeCachedSubtitle('abc', '3', ass, 'native-ass');
    const file = subtitleCachePath('abc', '3');
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (kind === 'version') entry.version = 1;
    if (kind === 'identity') entry.track = '4';
    if (kind === 'mediaKey') entry.mediaKey = 'def';
    if (kind === 'format') entry.format = 'srt';
    if (kind === 'producer') entry.producer = 'unknown';
    if (kind === 'digest') entry.content = ass.replace('mundo', 'outro');
    if (kind === 'count') entry.events = 2;
    fs.writeFileSync(file, kind === 'truncated' ? '{"version":' : kind === 'utf8' ? Buffer.from([0xff, 0xfe]) : JSON.stringify(entry));
    expect(readCachedSubtitle('abc', '3')).toBeNull();
  });
  it('rejects HTML regardless of size and preserves the previous valid file on publish failure', () => {
    expect(() => writeCachedSubtitle('abc', '3', '<html>' + 'x'.repeat(200), 'ffmpeg')).toThrow();
    writeCachedSubtitle('abc', '3', ass, 'native-ass');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk failure'); });
    expect(() => writeCachedSubtitle('abc', '3', ass.replace('mundo', 'novo'), 'ffmpeg')).toThrow();
    expect(readCachedSubtitle('abc', '3')).toBe(ass);
    expect(fs.readdirSync(state.dir)).toEqual(['abc_s3_v2.json']);
  });
  it('does not serve a legacy ASS and supports intentionally empty valid scripts', () => {
    fs.writeFileSync(path.join(state.dir, 'abc_s3.ass'), ass);
    expect(readCachedSubtitle('abc', '3')).toBeNull();
    const empty = ass.split('Dialogue:')[0];
    writeCachedSubtitle('abc', '3', empty, 'native-ass');
    expect(readCachedSubtitle('abc', '3')).toBe(empty);
  });
  it('keeps the previous envelope when a temporary write is interrupted', () => {
    writeCachedSubtitle('abc', '3', ass, 'native-ass');
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      write(file, '{');
      throw new Error('disk full');
    });
    expect(() => writeCachedSubtitle('abc', '3', ass.replace('mundo', 'novo'), 'ffmpeg')).toThrow('disk full');
    expect(readCachedSubtitle('abc', '3')).toBe(ass);
    expect(fs.readdirSync(state.dir)).toEqual(['abc_s3_v2.json']);
  });
  it('interleaves publishers without exposing partial envelopes or sharing temporaries', () => {
    writeCachedSubtitle('abc', '3', ass, 'native-ass');
    const rename = fs.renameSync;
    let interleaved = false;
    const temps = new Set<string>();
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      temps.add(String(from));
      expect(readCachedSubtitle('abc', '3')).not.toBeNull();
      if (!interleaved) {
        interleaved = true;
        writeCachedSubtitle('abc', '3', ass.replace('mundo', 'segundo'), 'ffmpeg');
        expect(readCachedSubtitle('abc', '3')).toContain('segundo');
      }
      rename(from, to);
    });
    writeCachedSubtitle('abc', '3', ass.replace('mundo', 'primeiro'), 'native-ass');
    expect(readCachedSubtitle('abc', '3')).toContain('primeiro');
    expect(temps.size).toBe(2);
    expect(fs.readdirSync(state.dir)).toEqual(['abc_s3_v2.json']);
  });
  it('never uses a URL or path as a cache filename', () => {
    expect(() => subtitleCachePath('../outside', '3')).toThrow();
    expect(() => subtitleCachePath('abc', '../3')).toThrow();
    expect(readCachedSubtitle('../outside', '3')).toBeNull();
  });
  it.each(['<html>' + 'x'.repeat(200), ass.replace('0:00:01.00', '0:99:01.00')])('validates structure even when the digest matches', content => {
    writeCachedSubtitle('abc', '3', ass, 'native-ass');
    const file = subtitleCachePath('abc', '3');
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    entry.content = content;
    entry.sha256 = createHash('sha256').update(content).digest('hex');
    fs.writeFileSync(file, JSON.stringify(entry));
    expect(readCachedSubtitle('abc', '3')).toBeNull();
  });
  it('refreshes the envelope mtime on a validated hit for TTL/LRU cleanup', async () => {
    writeCachedSubtitle('abc', '3', ass, 'native-ass');
    const file = subtitleCachePath('abc', '3');
    fs.utimesSync(file, new Date(0), new Date(0));
    expect(readCachedSubtitle('abc', '3')).toBe(ass);
    await vi.waitFor(() => expect(fs.statSync(file).mtimeMs).toBeGreaterThan(Date.now() - 10_000));
  });
});
