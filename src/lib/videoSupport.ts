import type { VideoInfo } from '../types/media';

/**
 * O servidor nunca recodifica vídeo: quem decodifica é o navegador de cada pessoa. HEVC (H.265), H.264 de 10 bits e
 * AV1 em hardware antigo são os casos em que o áudio toca e a imagem não aparece, sem erro nenhum. Aqui o navegador
 * diz se consegue decodificar o vídeo do arquivo, antes de a pessoa ficar olhando uma tela vazia.
 */

export interface VideoSupport {
  /** Nome para mostrar ("HEVC (H.265)"). */
  label: string;
  /** `null`: não sabemos montar o teste para esse codec (não avisar). */
  supported: boolean | null;
}

const LABELS: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC (H.265)',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  mpeg4: 'MPEG-4',
  mpeg2video: 'MPEG-2',
  vc1: 'VC-1',
};

const isHighBitDepth = (v: VideoInfo) => /(10|12)(le|be)?$/.test(v.pixFmt) || /10/.test(v.profile);

export function videoCodecLabel(v: VideoInfo): string {
  const base = LABELS[v.codec] || v.codec.toUpperCase();
  return isHighBitDepth(v) ? `${base} 10 bits` : base;
}

/** MIME com codec para `canPlayType`/MediaCapabilities, ou `null` para um codec que não sabemos testar. */
export function videoContentType(v: VideoInfo): string | null {
  const ten = isHighBitDepth(v);
  switch (v.codec) {
    case 'h264':
      return `video/mp4; codecs="${ten ? 'avc1.6E0033' : 'avc1.640033'}"`; // High 10 / High, nível 5.1
    case 'hevc':
      return `video/mp4; codecs="${ten ? 'hvc1.2.4.L153.B0' : 'hvc1.1.6.L153.B0'}"`; // Main 10 / Main, nível 5.1
    case 'av1':
      return `video/mp4; codecs="${ten ? 'av01.0.13M.10' : 'av01.0.13M.08'}"`;
    case 'vp9':
      return `video/webm; codecs="${ten ? 'vp09.02.10.10' : 'vp09.00.10.08'}"`;
    case 'vp8':
      return 'video/webm; codecs="vp8"';
    default:
      return null;
  }
}

export interface VideoSupportEnv {
  canPlayType: (contentType: string) => string;
  decodingInfo?: (config: unknown) => Promise<{ supported: boolean }>;
}

function browserEnv(): VideoSupportEnv {
  const probe = document.createElement('video');
  return {
    canPlayType: (ct) => probe.canPlayType(ct),
    decodingInfo: navigator.mediaCapabilities?.decodingInfo?.bind(navigator.mediaCapabilities),
  };
}

/** O navegador decodifica o vídeo deste arquivo? Prefere MediaCapabilities e cai para `canPlayType`. */
export async function checkVideoSupport(video: VideoInfo, env: VideoSupportEnv = browserEnv()): Promise<VideoSupport> {
  const label = videoCodecLabel(video);
  const contentType = videoContentType(video);
  if (!contentType) return { label, supported: null };
  if (env.decodingInfo) {
    try {
      const info = await env.decodingInfo({
        type: 'file',
        video: { contentType, width: video.width || 1920, height: video.height || 1080, bitrate: 10_000_000, framerate: 24 },
      });
      return { label, supported: Boolean(info.supported) };
    } catch {
      // cai para canPlayType
    }
  }
  return { label, supported: env.canPlayType(contentType) !== '' };
}
