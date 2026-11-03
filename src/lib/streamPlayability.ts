import type { VideoInfo } from '../types/media';
import type { StreamCodecs } from './streamInfo';
import { checkVideoSupport, type VideoSupportEnv } from './videoSupport';

/**
 * Três níveis, porque o nome do addon só dá pistas: `no` é certeza de que o Lunio não consegue tocar; `maybe` é
 * "pode falhar" (HEVC, AV1, Dolby Vision e áudio dependem do navegador e da máquina de cada pessoa, e o
 * stream pode até tocar); `ok` é o caso comum. Nada aqui bloqueia a escolha: só avisa.
 */

export type Playability = 'ok' | 'maybe' | 'no';
export type PlayabilityReason = 'not_web_ready' | 'proxy_headers' | 'hevc' | 'av1' | 'dolby_vision' | 'audio' | 'unknown';

export interface BrowserSupport {
  hevc: boolean;
  av1: boolean;
  ac3: boolean;
  eac3: boolean;
}

const NO_SUPPORT: BrowserSupport = { hevc: false, av1: false, ac3: false, eac3: false };

let cached: Promise<BrowserSupport> | null = null;

const probeVideo = (codec: string): VideoInfo => ({ codec, profile: '', pixFmt: 'yuv420p', width: 1920, height: 1080 });

async function probe(env?: VideoSupportEnv): Promise<BrowserSupport> {
  try {
    const e: VideoSupportEnv = env ?? {
      canPlayType: (ct) => document.createElement('video').canPlayType(ct),
      decodingInfo: navigator.mediaCapabilities?.decodingInfo?.bind(navigator.mediaCapabilities),
    };
    const [hevc, av1] = await Promise.all([checkVideoSupport(probeVideo('hevc'), e), checkVideoSupport(probeVideo('av1'), e)]);
    return {
      hevc: hevc.supported === true,
      av1: av1.supported === true,
      ac3: e.canPlayType('audio/mp4; codecs="ac-3"') !== '',
      eac3: e.canPlayType('audio/mp4; codecs="ec-3"') !== '',
    };
  } catch {
    return NO_SUPPORT; // sem navegador (Node, SSR) ou API bloqueada
  }
}

/** O que este navegador decodifica. Sem `env` usa o navegador real e guarda o resultado. */
export function detectBrowserSupport(env?: VideoSupportEnv): Promise<BrowserSupport> {
  if (env) return probe(env);
  return (cached ??= probe());
}

export function classifyStream(
  s: { codecs: StreamCodecs; notWebReady?: boolean; needsProxyHeaders: boolean },
  support: BrowserSupport,
): { level: Playability; reasons: PlayabilityReason[] } {
  if (s.notWebReady || s.needsProxyHeaders) {
    const reasons: PlayabilityReason[] = [];
    if (s.notWebReady) reasons.push('not_web_ready');
    if (s.needsProxyHeaders) reasons.push('proxy_headers');
    return { level: 'no', reasons };
  }

  const { videoCodec, dolbyVision, audio } = s.codecs;
  const reasons: PlayabilityReason[] = [];
  if (!videoCodec) reasons.push('unknown');
  if (videoCodec === 'hevc' && !support.hevc) reasons.push('hevc');
  if (videoCodec === 'av1' && !support.av1) reasons.push('av1');
  if (dolbyVision) reasons.push('dolby_vision');

  const playable = (a: StreamCodecs['audio'][number]) =>
    a === 'aac' || a === 'opus' || (a === 'ac3' && support.ac3) || (a === 'eac3' && support.eac3);
  if (audio.length > 0 && !audio.some(playable)) reasons.push('audio');

  return { level: reasons.length ? 'maybe' : 'ok', reasons };
}
