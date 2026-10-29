/** Qualidades de transmissão de tela que o Host pode escolher (sem troca automática). */
export type ScreenQualityId = '720p30' | '720p60' | '1080p30' | '1080p60' | '2160p30' | '2160p60';

export interface ScreenQuality {
  id: ScreenQualityId;
  label: string;
  width: number;
  height: number;
  fps: 30 | 60;
  /** Teto de bitrate de vídeo em bits por segundo. */
  maxBitrate: number;
}

export const SCREEN_QUALITIES: readonly ScreenQuality[] = [
  { id: '720p30', label: '720p 30 fps', width: 1280, height: 720, fps: 30, maxBitrate: 2_700_000 },
  { id: '720p60', label: '720p 60 fps', width: 1280, height: 720, fps: 60, maxBitrate: 4_500_000 },
  { id: '1080p30', label: '1080p 30 fps', width: 1920, height: 1080, fps: 30, maxBitrate: 6_000_000 },
  { id: '1080p60', label: '1080p 60 fps', width: 1920, height: 1080, fps: 60, maxBitrate: 10_000_000 },
  { id: '2160p30', label: '4K 30 fps', width: 3840, height: 2160, fps: 30, maxBitrate: 26_000_000 },
  { id: '2160p60', label: '4K 60 fps', width: 3840, height: 2160, fps: 60, maxBitrate: 45_000_000 },
];

export const DEFAULT_SCREEN_QUALITY: ScreenQualityId = '1080p60';

/** Procura por igualdade estrita (sem indexar objeto, por causa de `'__proto__'`); `null` fora da tabela. */
export function screenQuality(id: unknown): ScreenQuality | null {
  return SCREEN_QUALITIES.find((q) => q.id === id) ?? null;
}

/** Transmissão de tela ativa numa sala (estado só em memória, nunca vai ao Redis). */
export interface RoomScreen {
  sessionId: string;
  hostId: string;
  /** Nome do broadcast no relay: `lunio/<sala>/<32 hex>`. */
  path: string;
  quality: ScreenQualityId;
  startedAt: number;
  /** O Host já está publicando; antes disso os espectadores ainda não podem assistir. */
  live: boolean;
}
