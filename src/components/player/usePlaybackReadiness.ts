import { useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import type { PlaybackReadiness } from '../../types/media';
import { formatTime } from '../../lib/chapters';
import { logger } from '../../lib/logger';
import { syncManager } from '../../lib/sync';
import { getVideoElement } from './dom';

/**
 * Autoplay só quando vídeo + áudio + legenda obrigatória estão prontos. Também alinha o espectador à posição
 * da sala e faz o Host que recarregou a página retomar de onde a sala estava.
 */
export function usePlaybackReadiness(args: {
  readiness: PlaybackReadiness;
  autoPlay: boolean;
  paused: boolean;
  setPaused: Dispatch<SetStateAction<boolean>>;
  playerRef: RefObject<MediaPlayerInstance | null>;
  source: { src: string };
  handleSeekRef: MutableRefObject<(time: number) => void>;
  pendingPlayRef: MutableRefObject<boolean>;
}) {
  const { readiness, autoPlay, paused, setPaused, playerRef, source, handleSeekRef, pendingPlayRef } = args;
  // Vídeo para o qual o Host já retomou a posição da sala (evita repetir a cada mudança de readiness)
  const hostResumedSrcRef = useRef<string>('');
  // O autoplay vale uma vez por vídeo: sem isso, pausar disparava o play de novo (loop) e o usuário não conseguia pausar
  const autoStartedSrcRef = useRef<string>('');

  // PlaybackReadiness (v8): Autoplay inicia SOMENTE quando vídeo + áudio + legenda obrigatória estiverem prontos
  useEffect(() => {
    const isSubtitleReady =
      !readiness.selectedSubtitle.enabled ||
      !readiness.selectedSubtitle.required ||
      (readiness.selectedSubtitle.ready && !readiness.selectedSubtitle.failed);

    if (!readiness.video || !readiness.audio || !isSubtitleReady) return;

    // Se for espectador em Watch Party ativa e o Host estiver com o vídeo em reprodução
    if (!syncManager.isRoomHost()) {
      const roomState = syncManager.getRoomState();
      if (roomState && roomState.playback.playing) {
        const expected = syncManager.getExpectedPosition();
        const videoEl = getVideoElement(playerRef);
        if (videoEl) {
          if (Math.abs((videoEl.currentTime || 0) - expected) > 0.5) {
            videoEl.currentTime = expected;
          }
          if (videoEl.paused) {
            videoEl.play().catch(() => {});
          }
        }
        setPaused(false);
        return;
      }
    }

    // Host voltando para uma sala que já estava tocando (ex.: recarregou a página): retoma da posição da sala,
    // senão o próximo play dele levaria todo mundo de volta para o 00:00. Uma vez por vídeo.
    if (syncManager.isRoomHost() && hostResumedSrcRef.current !== source.src) {
      hostResumedSrcRef.current = source.src;
      const roomState = syncManager.getRoomState();
      const videoEl = getVideoElement(playerRef);
      if (roomState?.media?.url === source.src && videoEl && (videoEl.currentTime || 0) < 1) {
        const expected = syncManager.getExpectedPosition();
        if (expected > 2) {
          logger.info(`[Sala] Retomando a sala em ${formatTime(expected)}${roomState.playback.playing ? ' (tocando)' : ''}`);
          handleSeekRef.current(expected);
          if (roomState.playback.playing) {
            videoEl.play().catch(() => {});
            setPaused(false);
          }
          return;
        }
      }
    }

    const wantsAutoPlay = autoPlay && autoStartedSrcRef.current !== source.src;
    if (!wantsAutoPlay && !pendingPlayRef.current) return;

    if (paused) {
      if (autoPlay) autoStartedSrcRef.current = source.src;
      logger.info('[Player] Vídeo, áudio e legenda prontos; iniciando');
      const videoEl = getVideoElement(playerRef);

      if (videoEl) {
        videoEl.play().then(() => {
          pendingPlayRef.current = false;
        }).catch(() => {});
      } else if ((playerRef.current as any)?.state?.canPlay) {
        playerRef.current?.play().then(() => {
          pendingPlayRef.current = false;
        }).catch(() => {});
      }
      setPaused(false);
    }
  }, [readiness, autoPlay, paused]);
}
