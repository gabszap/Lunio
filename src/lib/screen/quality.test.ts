import { describe, expect, it } from 'vitest';
import { screenQuality } from '../../types/screen';
import { AUDIO_ENCODER_CONFIG, captureConstraints, captureFrameRate, keyframeInterval, qualityCost, videoEncoderConfig } from './quality';

const q = (id: string) => screenQuality(id)!;

describe('videoEncoderConfig', () => {
  it('1080p60 uses level 4.2, 10 Mbps, realtime annexb H.264', () => {
    expect(videoEncoderConfig(q('1080p60'), 1920, 1080)).toMatchObject({
      codec: 'avc1.64002a',
      width: 1920,
      height: 1080,
      bitrate: 10_000_000,
      framerate: 60,
      latencyMode: 'realtime',
      hardwareAcceleration: 'prefer-hardware',
      avc: { format: 'annexb' },
    });
  });

  it('4K60 asks for 45 Mbps and uses the size the capture actually gave', () => {
    const c = videoEncoderConfig(q('2160p60'), 2560, 1440);
    expect(c.bitrate).toBe(45_000_000);
    expect(c).toMatchObject({ width: 2560, height: 1440 });
  });
});

describe('captureConstraints', () => {
  it('asks for ideal and max size, 60 fps and untouched system audio', () => {
    const c = captureConstraints(q('1080p30')) as any;
    expect(c.video.width).toEqual({ ideal: 1920, max: 1920 });
    expect(c.video.height).toEqual({ ideal: 1080, max: 1080 });
    expect(c.video.frameRate).toEqual({ ideal: 60, max: 60 });
    expect(c.audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      systemAudio: 'include',
    });
  });

  it('keeps the page\'s own audio out of the captured system audio', () => {
    expect((captureConstraints(q('720p30')) as any).audio.restrictOwnAudio).toBe(true);
  });

  it('hides the Lunio tab itself from the picker (avoids an image loop and doubled sound)', () => {
    expect((captureConstraints(q('720p30')) as any).selfBrowserSurface).toBe('exclude');
  });

  it('always captures at 60 fps (the output rate is decimated later)', () => {
    expect(captureFrameRate(q('720p30'))).toBe(60);
  });
});

describe('keyframes and audio', () => {
  it('a keyframe every two seconds', () => {
    expect(keyframeInterval(q('720p30'))).toBe(60);
    expect(keyframeInterval(q('1080p60'))).toBe(120);
  });

  it('Opus 48 kHz stereo at 96 kbps', () => {
    expect(AUDIO_ENCODER_CONFIG).toEqual({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000 });
  });
});

describe('qualityCost (what the Host is told before choosing)', () => {
  it.each([
    ['720p30', 2.7, 1.2],
    ['720p60', 4.5, 2],
    ['1080p30', 6, 2.7],
    ['1080p60', 10, 4.5],
    ['2160p30', 26, 11.7],
    ['2160p60', 45, 20.3],
  ])('%s -> %f Mbps and about %f GB/h per viewer', (id, mbps, gb) => {
    expect(qualityCost(q(id))).toEqual({ mbps, gbPerHour: gb });
  });
});
