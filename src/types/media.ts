export type MediaSource = {
  src: string;
  type?: string;
};

export type Chapter = {
  index?: number;
  startTime: number;
  endTime?: number;
  title: string;
};

// Formatos suportados no pipeline de legendas
export type SubtitleFormat = 'ass' | 'ssa' | 'srt' | 'vtt' | 'unknown';

// Fontes de onde uma legenda pode ser descoberta (v8)
export type SubtitleSourceType = 'stream' | 'addon' | 'sidecar' | 'embedded';

// Ciclo de disponibilidade da legenda (descoberta vs pronta)
export type SubtitleAvailability = 'known' | 'pending' | 'ready' | 'failed';

// SubtitleCandidate (v8): Descoberta desacoplada, validação e ranking de candidatos
export interface SubtitleCandidate {
  id: string;
  language: string;
  format: SubtitleFormat;
  source: SubtitleSourceType;
  url?: string;
  trackId?: number;
  confidence: number; // 0 a 100
  forced: boolean;
  hearingImpaired?: boolean;
  title: string;
  availability: SubtitleAvailability;
  content?: string;
  /** Preenchidos quando `availability === 'failed'` (BITMAP_NOT_SUPPORTED, EXTRACTION_FAILED, HTTP_503…) */
  errorCode?: string;
  errorMessage?: string;
}

// Preferências do usuário para resolução automática de legendas
export interface SubtitlePreferences {
  preferredLanguages: string[]; // Ex: ['pt-br', 'por', 'pt', 'en']
  preferAssForAnime?: boolean;  // Default: true (prioriza estilização/karaoke JASSUB)
  requireSubtitle?: boolean;    // Se true, autoplay aguarda a legenda selecionada
  allowHearingImpaired?: boolean;
  autoSelectForced?: boolean;
}

// PlaybackReadiness (v8): Determina se o player pode reproduzir (vídeo + áudio + legenda obrigatória)
export interface PlaybackReadiness {
  video: boolean;
  audio: boolean;
  selectedSubtitle: {
    enabled: boolean;
    required: boolean;
    ready: boolean;
    failed?: boolean;
    candidateId?: string;
  };
}

// Referências estruturadas de mídia desacopladas
export interface AudioTrackRef {
  id: string;
  index: number;
  label: string;
  language?: string;
  codec?: string;
  isDefault?: boolean;
}

export interface SubtitleTrackRef {
  id: string;
  index: number;
  label: string;
  language: string;
  codec?: string;
  format: SubtitleFormat;
  isForced?: boolean;
  isDefault?: boolean;
}

export interface SubtitleSourceRef {
  id: string;
  url: string;
  language: string;
  format: SubtitleFormat;
  title?: string;
  source: SubtitleSourceType;
}

export interface EmbeddedFontRef {
  index: number;
  filename: string;
  mimetype?: string;
  codec?: string;
  url?: string;
}

// Objeto de mídia resolvido completo (v8)
export interface ResolvedMediaRef {
  mediaUrl: string;
  title: string;
  rawTitle?: string;
  filename?: string;
  duration?: number;
  size?: number;
  infoHash?: string;
  fileIndex?: number;
  videoHash?: string;
  /** Identidade lógica da mídia (estável entre tokens/URLs efêmeras). Gerada uma vez por `buildMediaFingerprint`. */
  mediaFingerprint?: string;
  audioTracks: AudioTrackRef[];
  subtitleTracks: SubtitleTrackRef[];
  externalSubtitleSources?: SubtitleSourceRef[];
  chapters?: Chapter[];
  parsedTorrent?: any;
  transport?: 'direct' | 'remux' | 'proxy';
  fonts?: EmbeddedFontRef[];
}

export type SubtitleTrack = {
  id?: string;
  src: string;
  label: string;
  language: string;
  type: 'ass' | 'ssa' | 'vtt';
  default?: boolean;
  isForced?: boolean;
  index?: number;
  content?: string;
  candidate?: SubtitleCandidate;
};

export type AudioTrackOption = {
  id: string;
  index?: number;
  label: string;
  language?: string;
  codec?: string;
  isDefault?: boolean;
};

export type LogLevel = 'info' | 'action' | 'warn' | 'error' | 'setting';

export type LogEntry = {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
};

export type MediaPayload = {
  url: string;
  mimeType?: string;
  title?: string;
  subtitles?: SubtitleTrack[];
  chapters?: Chapter[];
  audioTracks?: AudioTrackOption[];
  isMkv?: boolean;
};

export type PlayerPreset = {
  id: string;
  name: string;
  description: string;
  badge: string;
  payload: MediaPayload;
};
