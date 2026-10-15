import { describe, expect, it } from 'vitest';
import type { VideoInfo } from '../types/media';
import { checkVideoSupport, videoCodecLabel, videoContentType } from './videoSupport';

const video = (over: Partial<VideoInfo>): VideoInfo => ({ codec: 'h264', profile: '', pixFmt: 'yuv420p', width: 1920, height: 1080, ...over });

describe('videoSupport', () => {
  it('rótulos e tipos: 10 bits e HEVC têm o seu próprio teste', () => {
    expect(videoCodecLabel(video({ codec: 'hevc' }))).toBe('HEVC (H.265)');
    expect(videoCodecLabel(video({ codec: 'hevc', pixFmt: 'yuv420p10le', profile: 'Main 10' }))).toBe('HEVC (H.265) 10 bits');
    expect(videoCodecLabel(video({ codec: 'h264', pixFmt: 'yuv420p10le' }))).toBe('H.264 10 bits');
    expect(videoContentType(video({ codec: 'hevc' }))).toContain('hvc1.1.');
    expect(videoContentType(video({ codec: 'hevc', pixFmt: 'yuv420p10le' }))).toContain('hvc1.2.');
    expect(videoContentType(video({ codec: 'h264', pixFmt: 'yuv420p10le' }))).toContain('avc1.6E');
    expect(videoContentType(video({ codec: 'mpeg4' }))).toBeNull();
  });

  it('usa o MediaCapabilities quando existe', async () => {
    const env = { canPlayType: () => 'probably', decodingInfo: async () => ({ supported: false }) };
    expect(await checkVideoSupport(video({ codec: 'hevc' }), env)).toEqual({ label: 'HEVC (H.265)', supported: false });
  });

  it('sem MediaCapabilities (ou se ele falhar) cai para canPlayType', async () => {
    expect((await checkVideoSupport(video({ codec: 'av1' }), { canPlayType: () => '' })).supported).toBe(false);
    expect((await checkVideoSupport(video({ codec: 'av1' }), { canPlayType: () => 'maybe' })).supported).toBe(true);
    const throwing = { canPlayType: () => 'probably', decodingInfo: async () => { throw new Error('x'); } };
    expect((await checkVideoSupport(video({ codec: 'av1' }), throwing)).supported).toBe(true);
  });

  it('codec que não sabemos testar não gera aviso', async () => {
    const env = { canPlayType: () => '', decodingInfo: async () => ({ supported: false }) };
    expect((await checkVideoSupport(video({ codec: 'mpeg4' }), env)).supported).toBeNull();
  });
});
