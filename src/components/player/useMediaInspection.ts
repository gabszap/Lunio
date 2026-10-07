import { useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { AudioTrackOption, Chapter, SubtitleTrack } from '../../types/media';
import { formatTime } from '../../lib/chapters';
import { logger } from '../../lib/logger';
import { getYouTubeId, resolveMediaRef } from '../../lib/media';
import { sessionManager } from '../../lib/session';
import { getProgressStorageKey } from './progress';
import type { useAlternateAudio } from './useAlternateAudio';
import type { useSubtitles } from './useSubtitles';

/**
 * Ao mudar a fonte: decide a URL do stream, lê faixas/capítulos/duração no servidor (FFmpeg), abre a sessão de mídia,
 * resolve as legendas e sugere "continuar de onde parou".
 */
export function useMediaInspection(args: {
  source: { src: string };
  hasSource: boolean;
  title?: string;
  initialChapters: Chapter[];
  initialSubtitles: SubtitleTrack[];
  initialAudioTracks: AudioTrackOption[];
  audio: ReturnType<typeof useAlternateAudio>;
  subs: ReturnType<typeof useSubtitles>;
  currentChapterRef: MutableRefObject<Chapter | null>;
  pendingPlayRef: MutableRefObject<boolean>;
  totalDurationRef: MutableRefObject<number>;
  setPlaybackError: Dispatch<SetStateAction<any>>;
  setResumePrompt: Dispatch<SetStateAction<{ time: number; formatted: string } | null>>;
  setMediaTitle: Dispatch<SetStateAction<string>>;
  setParsedMetadata: Dispatch<SetStateAction<any>>;
  setDuration: Dispatch<SetStateAction<number>>;
}) {
  const {
    source, hasSource, title, initialChapters, initialSubtitles, initialAudioTracks, audio, subs,
    currentChapterRef, pendingPlayRef, totalDurationRef, setPlaybackError, setResumePrompt, setMediaTitle, setParsedMetadata, setDuration,
  } = args;
  const { setResolvedStreamUrl, setDetectedAudioTracks, setActiveAudioTrack } = audio;
  const { setDetectedSubtitles, resetSubtitleState, applyResolvedSubtitles, applyLocalSubtitles } = subs;

  const [detectedChapters, setDetectedChapters] = useState<Chapter[]>(initialChapters);
  const [isInspecting, setIsInspecting] = useState<boolean>(false);

  useEffect(() => {
    if (title) setMediaTitle(title);
  }, [title]);

  // Inspeção automática de faixas via FFmpeg ao mudar a fonte
  useEffect(() => {
    let isCancelled = false;
    setPlaybackError(null);
    resetSubtitleState();
    currentChapterRef.current = null;
    pendingPlayRef.current = false;

    if (!hasSource) {
      setResolvedStreamUrl('');
      setIsInspecting(false);
      sessionManager.closeSession();
      return;
    }

    // Checa se há progresso salvo para sugerir retomada em popup (o vídeo sempre inicia do 0)
    try {
      const savedTime = parseFloat(localStorage.getItem(getProgressStorageKey(source.src)) || '0');
      if (savedTime > 10) {
        setResumePrompt({ time: savedTime, formatted: formatTime(savedTime) });
      } else {
        setResumePrompt(null);
      }
    } catch {
      setResumePrompt(null);
    }

    const ytId = getYouTubeId(source.src);
    if (ytId) {
      setResolvedStreamUrl(`youtube/${ytId}`);
      setIsInspecting(false);
      setDetectedChapters(initialChapters);
      setDetectedSubtitles(initialSubtitles);
      setDetectedAudioTracks([]);
      setActiveAudioTrack(null);
      logger.info(`[Mídia] Vídeo do YouTube: ${ytId}`);
      return () => {
        isCancelled = true;
      };
    }

    const isRemoteStream = source.src.startsWith('http://') || source.src.startsWith('https://');

    // Roteia via proxy nativo para bypass de CORS, SSL e redirecionamento de links debrid
    if (isRemoteStream && !source.src.startsWith('/api/proxy')) {
      const proxyUrl = `/api/proxy?url=${encodeURIComponent(source.src)}#.mp4`;
      setResolvedStreamUrl(proxyUrl);
    } else {
      setResolvedStreamUrl(source.src);
    }

    if (isRemoteStream) {
      setIsInspecting(true);
      logger.info('[Mídia] Lendo faixas de áudio, legendas e capítulos…');

      resolveMediaRef(source.src, initialSubtitles)
        .then(async (resolvedMedia) => {
          if (isCancelled || !resolvedMedia) return;

          // Fase 2: Registra a sessão de mídia formal com generation tracking
          sessionManager.createSession(resolvedMedia, 0);

          if (resolvedMedia.title) {
            setMediaTitle(resolvedMedia.title);
            logger.info(`[Mídia] Título: ${resolvedMedia.title}`);
          }
          if (resolvedMedia.parsedTorrent) {
            setParsedMetadata(resolvedMedia.parsedTorrent);
          }
          if (resolvedMedia.duration && resolvedMedia.duration > 0) {
            totalDurationRef.current = resolvedMedia.duration;
            setDuration(resolvedMedia.duration);
            logger.info(`[Mídia] Duração: ${formatTime(resolvedMedia.duration)}`);
          }

          const audios: AudioTrackOption[] = (resolvedMedia.audioTracks || []).map((a) => ({
            id: a.id,
            index: a.index,
            label: a.label,
            language: a.language,
            codec: a.codec,
            isDefault: a.isDefault,
          }));

          const chaps: Chapter[] = (resolvedMedia.chapters || []).map((c) => ({
            startTime: c.startTime,
            endTime: c.endTime,
            title: c.title,
          }));

          // Se duration não estiver presente, infere duração pelo término do último capítulo
          if (chaps.length > 0) {
            const maxChapEnd = Math.max(0, ...chaps.map((c) => c.endTime || c.startTime || 0));
            if (maxChapEnd > totalDurationRef.current) {
              totalDurationRef.current = maxChapEnd;
              setDuration(maxChapEnd);
              logger.info(`[Mídia] Duração estimada pelos capítulos: ${formatTime(maxChapEnd)}`);
            }
          }

          if (audios.length > 0) {
            setDetectedAudioTracks(audios);
            setActiveAudioTrack(audios[0]);
            logger.info(`[Mídia] ${audios.length} ${audios.length === 1 ? 'faixa' : 'faixas'} de áudio`);
          } else {
            setDetectedAudioTracks(initialAudioTracks);
          }

          if (chaps.length > 0) {
            setDetectedChapters(chaps);
            logger.info(`[Mídia] ${chaps.length} ${chaps.length === 1 ? 'capítulo' : 'capítulos'}`);
          } else {
            setDetectedChapters(initialChapters);
          }

          await applyResolvedSubtitles(resolvedMedia, audios, () => isCancelled);
        })
        .catch((err) => {
          logger.warn('[Mídia] Não deu pra ler todas as faixas:', err);
        })
        .finally(() => {
          if (!isCancelled) setIsInspecting(false);
        });
    } else {
      setDetectedAudioTracks(initialAudioTracks);
      setDetectedChapters(initialChapters);
      applyLocalSubtitles();
      setActiveAudioTrack(initialAudioTracks[0] || null);
    }

    return () => {
      isCancelled = true;
    };
  }, [source.src]);

  return { detectedChapters, isInspecting };
}
