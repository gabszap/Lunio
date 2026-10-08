import {
  Chapter,
  MediaPayload,
  PlayerPreset,
  SubtitleTrack,
  ResolvedMediaRef,
  AudioTrackRef,
  SubtitleTrackRef,
  SubtitleSourceRef,
  EmbeddedFontRef,
} from '../types/media';
import { logger } from './logger';
import { apiFetch, withAccess } from './access';

export function detectMimeType(url: string, providedMime?: string): string {
  if (providedMime && providedMime.trim().length > 0) {
    return providedMime.trim();
  }

  try {
    const parsed = new URL(url, window.location.origin);
    const pathname = parsed.pathname.toLowerCase();

    if (pathname.endsWith('.mp4') || pathname.endsWith('.m4v')) {
      return 'video/mp4';
    }
    if (pathname.endsWith('.mkv') || url.includes('torrentio.strem.fun')) {
      return 'video/x-matroska';
    }
    if (pathname.endsWith('.webm')) {
      return 'video/webm';
    }
    if (pathname.endsWith('.m3u8')) {
      return 'application/x-mpegurl';
    }
  } catch {
    const lower = url.toLowerCase();
    if (lower.includes('.mp4')) return 'video/mp4';
    if (lower.includes('.mkv') || lower.includes('torrentio')) return 'video/x-matroska';
    if (lower.includes('.webm')) return 'video/webm';
  }

  return 'video/mp4';
}

/**
 * Extrai o ID de um link do YouTube (watch, youtu.be, shorts, live, embed).
 * Retorna null para qualquer outra URL.
 */
export function getYouTubeId(rawUrl: string): string | null {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return null;
  if (/^youtube\/[\w-]{6,}$/.test(trimmed)) return trimmed.slice('youtube/'.length);
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const host = url.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id && /^[\w-]{6,}$/.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
      const v = url.searchParams.get('v');
      if (v && /^[\w-]{6,}$/.test(v)) return v;
      const [kind, id] = url.pathname.split('/').filter(Boolean);
      if (['shorts', 'live', 'embed', 'v'].includes(kind) && id && /^[\w-]{6,}$/.test(id)) return id;
    }
  } catch {
    // não é URL
  }
  return null;
}

export function validateAndFormatUrl(rawUrl: string): string {
  if (!rawUrl || !rawUrl.trim()) return '';
  const trimmed = rawUrl.trim();
  try {
    const urlObj = new URL(trimmed);
    return urlObj.toString();
  } catch {
    if (trimmed.startsWith('//')) {
      return `https:${trimmed}`;
    }
    return trimmed;
  }
}

/**
 * Converte arquivos de legenda SRT para formato VTT válido nativamente
 */
export function srtToVtt(srtContent: string): string {
  const normalized = srtContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

  return `WEBVTT\n\n${normalized.trim()}\n`;
}

/**
 * Inspeciona as faixas embutidas (áudio, legendas e capítulos) usando o backend FFmpeg
 */
export async function inspectMediaTracks(url: string) {
  try {
    const res = await apiFetch(`/api/tracks?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn('[inspectMediaTracks error]', err);
    return null;
  }
}

/**
 * Converte a inspeção da mídia em um objeto ResolvedMediaRef desacoplado (v8)
 */
export async function resolveMediaRef(
  url: string,
  externalSubs: any[] = []
): Promise<ResolvedMediaRef> {
  const data = await inspectMediaTracks(url);

  const audioTracks: AudioTrackRef[] = (data?.audios || []).map((a: any) => ({
    id: String(a.index),
    index: a.index,
    label: a.title,
    language: a.language,
    codec: a.codec,
    isDefault: a.isDefault,
  }));

  const subtitleTracks: SubtitleTrackRef[] = (data?.subtitles || []).map((s: any) => ({
    id: String(s.index),
    index: s.index,
    label: s.title,
    language: s.language,
    codec: s.codec,
    format: s.codec?.includes('ass') || s.codec?.includes('ssa') ? 'ass' : 'srt',
    isForced: s.isForced,
    isDefault: s.isDefault,
  }));

  const externalSubtitleSources: SubtitleSourceRef[] = externalSubs.map((es, idx) => ({
    id: es.id || `ext_${idx}`,
    url: es.url || es.src,
    language: es.lang || es.language || 'und',
    format: es.format || (es.url?.endsWith('.ass') ? 'ass' : 'srt'),
    title: es.label || es.title || `Legenda Externa ${idx + 1}`,
    source: es.source || 'stream',
  }));

  const chapters: Chapter[] = (data?.chapters || []).map((c: any) => ({
    index: c.index,
    startTime: c.startTime,
    endTime: c.endTime,
    title: c.title,
  }));

  const fonts: EmbeddedFontRef[] = (data?.fonts || []).map((f: any) => ({
    index: f.index,
    filename: f.filename || `font_${f.index}`,
    mimetype: f.mimetype,
    codec: f.codec,
    // O JASSUB busca a fonte sem cabeçalhos: o token vai na URL
    url: withAccess(`/api/font?url=${encodeURIComponent(url)}&track=${f.index}&name=${encodeURIComponent(f.filename || '')}`),
  }));

  return {
    mediaUrl: url,
    title: data?.title || '',
    rawTitle: data?.rawTitle || '',
    duration: data?.duration || 0,
    audioTracks,
    subtitleTracks,
    externalSubtitleSources,
    chapters,
    parsedTorrent: data?.parsedTorrent,
    fonts,
  };
}

export const PRESETS: PlayerPreset[] = [
  {
    id: 'sintel-local',
    name: 'Sintel (Bundled Instant 1080p)',
    badge: 'Local Zero-Buffer / ASS / Multi-Sub',
    description: 'Instant zero-buffering playback directly served from the container, with audio boost, chapters, and ASS/SSA subtitles.',
    payload: {
      url: '/sintel.mp4',
      mimeType: 'video/mp4',
      title: 'Sintel (The Dragon Seeker)',
      chapters: [
        { startTime: 0, endTime: 12, title: '01 The Snowy Mountain' },
        { startTime: 12, endTime: 28, title: '02 The Village Tavern' },
        { startTime: 28, endTime: 44, title: '03 Dragon Memories' },
        { startTime: 44, endTime: 52, title: '04 Credits' },
      ],
      subtitles: [
        {
          src: '/subtitles/sample-anime.ass',
          label: 'Japanese Styled (ASS - JASSUB WASM)',
          language: 'ja',
          type: 'ass',
          default: true,
        },
        {
          src: '/subtitles/sample-pt.vtt',
          label: 'Português (VTT)',
          language: 'pt-BR',
          type: 'vtt',
        },
        {
          src: '/subtitles/sample-en.vtt',
          label: 'English (VTT)',
          language: 'en',
          type: 'vtt',
        },
      ],
      audioTracks: [
        { id: 'audio-main', label: 'English Master (Stereo)', language: 'en' },
        { id: 'audio-pt', label: 'Português Brasileiro (Dublado)', language: 'pt' },
      ],
    },
  },
  {
    id: 'tears-of-steel-1080p',
    name: 'Tears of Steel (1080p Full HD)',
    badge: '1080p Direct / ASS / Chapters',
    description: 'Full HD 1080p direct stream with anime-style ASS subtitles (JASSUB WASM), skip opening (+90s), and chapter navigation.',
    payload: {
      url: 'https://archive.org/download/Tears-of-Steel/tears_of_steel_1080p.mp4',
      mimeType: 'video/mp4',
      title: 'Tears of Steel (1080p Full HD)',
      chapters: [
        { startTime: 0, endTime: 15, title: 'Cold Open' },
        { startTime: 15, endTime: 105, title: 'Opening (Hikari no Senritsu)' },
        { startTime: 105, endTime: 360, title: 'Main Story - The Signal' },
        { startTime: 360, endTime: 600, title: 'Bridge Confrontation' },
        { startTime: 600, endTime: 700, title: 'Ending Theme' },
        { startTime: 700, endTime: 734, title: 'Preview - Next Episode' },
      ],
      subtitles: [
        {
          src: '/subtitles/sample-anime.ass',
          label: 'Japanese Styled (ASS - JASSUB WASM)',
          language: 'ja',
          type: 'ass',
          default: true,
        },
        {
          src: '/subtitles/sample-pt.vtt',
          label: 'Português (VTT)',
          language: 'pt-BR',
          type: 'vtt',
        },
      ],
      audioTracks: [
        { id: 'audio-main', label: 'English 5.1 Mix', language: 'en' },
        { id: 'audio-pt', label: 'Português Brasileiro (Dublagem)', language: 'pt' },
      ],
    },
  },
  {
    id: 'big-buck-bunny-1080p',
    name: 'Big Buck Bunny (1080p Surround)',
    badge: '1080p Direct / 5.1 Surround',
    description: 'Direct 1080p stream testing rapid seek (±10s), volume boost up to 200% (Web Audio), and multi-subtitles.',
    payload: {
      url: 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_1080p_surround.mp4',
      mimeType: 'video/mp4',
      title: 'Big Buck Bunny (1080p Surround)',
      chapters: [
        { startTime: 0, endTime: 150, title: 'Morning in the Forest' },
        { startTime: 150, endTime: 320, title: 'The Flying Squirrels' },
        { startTime: 320, endTime: 480, title: 'The Apple Trap' },
        { startTime: 480, endTime: 596, title: 'The Finale' },
      ],
      subtitles: [
        {
          src: '/subtitles/sample-pt.vtt',
          label: 'Português (VTT)',
          language: 'pt-BR',
          type: 'vtt',
          default: true,
        },
      ],
      audioTracks: [
        { id: 'audio-5.1', label: '5.1 Surround Master (AC3/AAC)', language: 'und' },
      ],
    },
  },
];
