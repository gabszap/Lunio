import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedMediaRef, SubtitleCandidate, SubtitleTrack } from '../types/media';
const renderers = vi.hoisted(() => ({ instances: [] as Array<{ ready: Promise<void>; finish: () => void; destroy: () => Promise<void>; timeOffset: number }> }));
vi.mock('jassub', () => ({ default: class {
  ready: Promise<void>;
  timeOffset = 0;
  finish!: () => void;
  destroy = async () => { await this.ready; };
  constructor() { this.ready = new Promise(resolve => { this.finish = resolve; }); renderers.instances.push(this); }
} }));

vi.mock('@vidstack/react', () => ({ LibASSTextRenderer: class {} }));
vi.mock('./access', () => ({ apiFetch: vi.fn() }));
vi.mock('./session', () => ({ sessionManager: { getSession: () => null } }));
import { apiFetch } from './access';
import { SubtitleManager, SubtitleResolver } from './subtitles';

const ass = '[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Olá\n';
const media = { mediaUrl: 'https://test/movie.mkv', mediaFingerprint: 'test', audioTracks: [{ language: 'jpn' }], subtitleTracks: [{ index: 3, language: 'por', format: 'srt', codec: 'subrip', label: 'Português' }], externalSubtitleSources: [] } as unknown as ResolvedMediaRef;

beforeEach(() => { vi.mocked(apiFetch).mockImplementation(async () => new Response(new Uint8Array([0, 1]))); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('subtitle delivery and renderer selection', () => {
  it('embedded SRT advertises delivered ASS while retaining source format', async () => {
    const resolver = new SubtitleResolver();
    const { candidates } = await resolver.resolveCandidates(media);
    expect(candidates[0]).toMatchObject({ format: 'ass', sourceFormat: 'srt' });
    expect(resolver.candidateToTrack(candidates[0]).type).toBe('ass');
  });
  it('does not rank converted SRT as original styled ASS', async () => {
    const resolver = new SubtitleResolver();
    const { candidates } = await resolver.resolveCandidates({ ...media, subtitleTracks: [...media.subtitleTracks, { ...media.subtitleTracks[0], index: 4, format: 'ass', codec: 'ass' }] });
    const ranked = resolver.rankCandidates(candidates, media, { preferredLanguages: ['por'], preferAssForAnime: true });
    expect(ranked[0].trackId).toBe(4);
  });
  it('rejects HTML without marking it ready', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('<html>origin error</html>'));
    const candidate: SubtitleCandidate = { id: 'x', source: 'stream', format: 'srt', language: 'por', url: '/sub', forced: false, confidence: 0, title: 'x', availability: 'known' };
    await expect(new SubtitleResolver().prepareCandidate(candidate)).rejects.toMatchObject({ code: 'SUBTITLE_INVALID' });
    expect(candidate.availability).toBe('failed');
  });
  it('selects renderer using actual content instead of a stale track type', async () => {
    vi.stubGlobal('document', { querySelector: () => null });
    const manager = new SubtitleManager();
    const attachAss = vi.spyOn(manager, 'attachDirectJassub').mockResolvedValue();
    const attachNative = vi.spyOn(manager, 'attachNativeTrack').mockResolvedValue();
    const track = { id: 'x', type: 'vtt', label: 'x', content: ass } as SubtitleTrack;
    await manager.applyTrack({} as HTMLVideoElement, track);
    expect(attachAss).toHaveBeenCalledOnce();
    expect(attachNative).not.toHaveBeenCalled();
  });
  it('waits for native track load, propagates errors and removes failed blobs', async () => {
    const element = Object.assign(new EventTarget(), { kind: '', label: '', srclang: '', src: '', default: false, track: { mode: 'disabled', cues: [] }, remove: vi.fn() });
    vi.stubGlobal('document', { createElement: () => element });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const manager = new SubtitleManager();
    let settled = false;
    const promise = manager.attachNativeTrack({ appendChild: vi.fn() } as unknown as HTMLVideoElement, { id: 'x', type: 'vtt', label: 'x', content: 'WEBVTT\n\n00:01.000 --> 00:02.000\nOlá' } as SubtitleTrack);
    const outcome = promise.then(() => null, error => error);
    promise.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    const settledBeforeLoad = settled;
    const modeBeforeLoad = element.track.mode;
    element.dispatchEvent(new Event('error'));
    expect(await outcome).toBeInstanceOf(Error);
    expect(settledBeforeLoad).toBe(false);
    expect(modeBeforeLoad).toBe('hidden');
    expect(revoke).toHaveBeenCalledWith('blob:test');
  });

  it('rejects an older ASS initialization that finishes after a new track', async () => {
    vi.stubGlobal('document', { querySelector: () => null });
    renderers.instances.length = 0;
    const manager = new SubtitleManager();
    const first = manager.applyTrack({} as HTMLVideoElement, { id: 'a', type: 'ass', label: 'a', content: ass } as SubtitleTrack).then(() => null, e => e);
    await vi.waitFor(() => expect(renderers.instances).toHaveLength(1));
    manager.setSubtitleDelay(0.5);
    const second = manager.applyTrack({} as HTMLVideoElement, { id: 'b', type: 'ass', label: 'b', content: ass } as SubtitleTrack, 120);
    await vi.waitFor(() => expect(renderers.instances).toHaveLength(2));
    renderers.instances[1].finish();
    await second;
    expect(renderers.instances[1].timeOffset).toBe(120.5);
    manager.setTimeOffset(0);
    expect(renderers.instances[1].timeOffset).toBe(0.5);
    renderers.instances[0].finish();
    expect(await first).toMatchObject({ name: 'AbortError' });
    manager.destroyDirectJassub();
  });

  it('loads needed fonts before initializing and propagates font failure', async () => {
    vi.stubGlobal('document', { querySelector: () => null });
    renderers.instances.length = 0;
    vi.mocked(apiFetch).mockResolvedValue(new Response('unavailable', { status: 503 }));
    const status = vi.fn();
    const manager = new SubtitleManager();
    const result = manager.applyTrack({} as HTMLVideoElement, { type: 'ass', label: 'x', content: ass } as SubtitleTrack, 0, undefined, status);
    await expect(result).rejects.toMatchObject({ code: 'SUBTITLE_FONT_FAILED' });
    expect(renderers.instances).toHaveLength(0);
    expect(status.mock.calls.map(([value]) => value.stage)).toEqual(['loading_fonts', 'failed']);
  });

  it('aborts sibling font transfers when one font fails, even before caller cleanup', async () => {
    vi.stubGlobal('document', { querySelector: () => null });
    const signals: AbortSignal[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url, options) => {
      const signal = options!.signal as AbortSignal;
      signals.push(signal);
      if (String(url).endsWith('trebuc.ttf')) return new Response('unavailable', { status: 503 });
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const caller = new AbortController();
    const manager = new SubtitleManager();
    await expect(manager.applyTrack({} as HTMLVideoElement, { type: 'ass', content: ass } as SubtitleTrack, 0, caller.signal)).rejects.toMatchObject({ code: 'SUBTITLE_FONT_FAILED' });
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    caller.abort();
  });

  it('does not remove a newer native track when the previous load is cancelled', async () => {
    const elements = [0, 1].map(() => Object.assign(new EventTarget(), { track: { mode: 'disabled', cues: [] }, remove: vi.fn() }));
    let next = 0;
    vi.stubGlobal('document', { querySelector: () => null, createElement: () => elements[next++] });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const manager = new SubtitleManager();
    const video = { appendChild: vi.fn() } as unknown as HTMLVideoElement;
    const track = { type: 'vtt', label: 'test', content: 'WEBVTT\n\n00:01.000 --> 00:02.000\nOlá' } as SubtitleTrack;
    const first = manager.applyTrack(video, { ...track }).catch(error => error);
    const second = manager.applyTrack(video, { ...track });
    await Promise.resolve();
    elements[1].dispatchEvent(new Event('load'));
    await second;
    expect(await first).toMatchObject({ name: 'AbortError' });
    expect(elements[1].remove).not.toHaveBeenCalled();
    expect(elements[1].track.mode).toBe('showing');
    manager.destroyNativeTrack();
  });

  it('retimes native original cues idempotently, removes and restores elapsed cues', async () => {
    const cue = { startTime: 121, endTime: 123, id: 'line', text: 'Olá', align: 'end' };
    const cues = [cue];
    const native = { mode: 'disabled', cues, addCue: vi.fn((value) => cues.push(value)), removeCue: vi.fn((value) => cues.splice(cues.indexOf(value), 1)) };
    const element = Object.assign(new EventTarget(), { track: native, remove: vi.fn() });
    vi.stubGlobal('document', { querySelector: () => null, createElement: () => element });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const manager = new SubtitleManager();
    manager.setSubtitleDelay(0.5);
    const load = manager.applyTrack({ appendChild: vi.fn() } as unknown as HTMLVideoElement, { type: 'vtt', content: 'WEBVTT\n\n02:01.000 --> 02:03.000\nOlá' } as SubtitleTrack, 120);
    element.dispatchEvent(new Event('load'));
    await load;
    expect(cue).toMatchObject({ startTime: 0.5, endTime: 2.5, id: 'line', text: 'Olá', align: 'end' });
    manager.setTimeOffset(120);
    expect(cue.startTime).toBe(0.5);
    manager.setTimeOffset(125);
    expect(cues).toHaveLength(0);
    manager.setTimeOffset(0);
    expect(cues).toEqual([cue]);
    expect(cue.startTime).toBe(120.5);
    expect(manager.getSubtitleDelay()).toBe(0.5);
    manager.setSubtitleDelay(0);
    expect(cue.startTime).toBe(121);
    manager.destroyNativeTrack();
  });

  it('preserves a remux origin changed while subtitle content is still downloading', async () => {
    let finish!: (response: Response) => void;
    vi.mocked(apiFetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const cue = { startTime: 121, endTime: 123 };
    const native = { mode: 'disabled', cues: [cue], addCue: vi.fn(), removeCue: vi.fn() };
    const element = Object.assign(new EventTarget(), { track: native, remove: vi.fn() });
    vi.stubGlobal('document', { querySelector: () => null, createElement: () => element });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pending');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const manager = new SubtitleManager();
    const load = manager.applyTrack({ appendChild: vi.fn() } as unknown as HTMLVideoElement, { type: 'vtt', src: '/external.vtt' } as SubtitleTrack);
    manager.setTimeOffset(120);
    finish(new Response('WEBVTT\n\n02:01.000 --> 02:03.000\nOlá'));
    await vi.waitFor(() => expect(native.mode).toBe('hidden'));
    element.dispatchEvent(new Event('load'));
    await load;
    expect(cue.startTime).toBe(1);
    manager.destroyNativeTrack();
  });
});
