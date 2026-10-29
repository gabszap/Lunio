import type { ScreenQuality } from '../../types/screen';
import { avcCodecFor } from './h264';

/** Quadro-chave a cada 2 s: é também o ponto de entrada de quem chega ou volta a assistir. */
export const KEYFRAME_EVERY_SECONDS = 2;

/** A captura sempre pede 60 fps (pedir 30 rende ~21): o fps da qualidade escolhida é obtido decimando depois. */
export function captureFrameRate(_q: ScreenQuality): number {
  return 60;
}

export function captureConstraints(q: ScreenQuality): DisplayMediaStreamOptions {
  const fps = captureFrameRate(q);
  return {
    video: {
      width: { ideal: q.width, max: q.width },
      height: { ideal: q.height, max: q.height },
      frameRate: { ideal: fps, max: fps },
    },
    // Áudio do sistema como está: sem cancelamento de eco, supressão de ruído nem ganho automático
    // O Chromium esconde a aba do Lunio da lista: transmitir a própria aba cria um laço de imagem e som
    selfBrowserSurface: 'exclude',
    audio: { systemAudio: 'include', echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
  } as DisplayMediaStreamOptions;
}

export function videoEncoderConfig(q: ScreenQuality, width: number, height: number): VideoEncoderConfig {
  return {
    codec: avcCodecFor(width, height, q.fps),
    width,
    height,
    bitrate: q.maxBitrate,
    framerate: q.fps,
    latencyMode: 'realtime',
    hardwareAcceleration: 'prefer-hardware',
    avc: { format: 'annexb' },
  };
}

export function keyframeInterval(q: ScreenQuality): number {
  return q.fps * KEYFRAME_EVERY_SECONDS;
}

export const AUDIO_ENCODER_CONFIG: AudioEncoderConfig = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000 };
