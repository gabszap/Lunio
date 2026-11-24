import { useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import type { PlaybackReadiness } from '../../types/media';
import { formatTime } from '../../lib/chapters';
import { logger } from '../../lib/logger';
import { syncManager } from '../../lib/sync';
import { clearStartTime, readStartTime } from '../../lib/startTime';
import { getVideoElement } from './dom';
import type { PlayerSeek } from './usePlaybackControls';

/**
 * Autoplay só quando vídeo + áudio + legenda obrigatória estão prontos. Também alinha o espectador à posição
 * da sala e faz o Host que recarregou a página retomar de onde a sala estava.
 */
export function usePlaybackReadiness(args: {
  readiness: PlaybackReadiness;
  autoPlay: boolean;
  paused: boolean;
  setPaused: Dispatch<SetStateAction<boolean>>;
  setPlaybackRate: Dispatch<SetStateAction<number>>;
  playerRef: RefObject<MediaPlayerInstance | null>;
  source: { src: string };
  handleSeekRef: MutableRefObject<PlayerSeek>;
  lastKnownTimeRef: MutableRefObject<number>;
  pendingPlayRef: MutableRefObject<boolean>;
  syncStatus: ReturnType<typeof syncManager.getStatus>;
}) {
  const {
    readiness, autoPlay, paused, setPaused, setPlaybackRate, playerRef, source,
    handleSeekRef, lastKnownTimeRef, pendingPlayRef, syncStatus,
  } = args;
  const { isConnected, isHost, roomId } = syncStatus;
  const confirmedPlayback = syncManager.getConfirmedPlayback(source.src);
  const alignedMediaRef = useRef<typeof confirmedPlayback>(null);
  // Vídeo para o qual o Host já retomou a posição da sala (evita repetir a cada mudança de readiness)
  const hostResumedSrcRef = useRef<string>('');
  // O autoplay vale uma vez por vídeo: sem isso, pausar disparava o play de novo (loop) e o usuário não conseguia pausar
  const autoStartedSrcRef = useRef<string>('');

  // PlaybackReadiness (v8): Autoplay inicia SOMENTE quando vídeo + áudio + legenda obrigatória estiverem prontos
  useEffect(() => {
    if (!isConnected || isHost) alignedMediaRef.current = null;
    if (roomId && !isConnected) return;

    const isSubtitleReady =
      !readiness.selectedSubtitle.enabled ||
      !readiness.selectedSubtitle.required ||
      (readiness.selectedSubtitle.ready && !readiness.selectedSubtitle.failed);

    if (!readiness.video || !readiness.audio || !isSubtitleReady) return;

    // Aplica o estado recebido ao entrar ou reconectar, inclusive quando o Host está pausado.
    if (!isHost) {
      const roomState = syncManager.getRoomState();
      const videoEl = getVideoElement(playerRef);
      if (!videoEl || !roomState || !confirmedPlayback || alignedMediaRef.current === confirmedPlayback) return;
      if (syncManager.getConfirmedPlayback(source.src) !== confirmedPlayback) return;
      alignedMediaRef.current = confirmedPlayback;

      const { playing, rate } = roomState.playback;
      const expected = syncManager.getExpectedPosition();
      if (!playing) {
        pendingPlayRef.current = false;
        videoEl.pause();
      }
      if (Math.abs(lastKnownTimeRef.current - expected) > 0.5) {
        handleSeekRef.current(expected, { playing });
      }
      videoEl.playbackRate = rate;
      setPlaybackRate(rate);
      if (!playing || !videoEl.paused) {
        setPaused(!playing);
      } else {
        videoEl.play().catch(() => {});
      }
      return;
    }

    // Link com `?t=`: quem tem o controle (sozinho ou Host) abre o vídeo naquele instante, uma vez. Vale mais que a
    // retomada abaixo. Sala ainda sem estado (não sabemos se somos Host): espera, o espectador segue o Host.
    const startAt = readStartTime();
    if (startAt !== null && (!syncManager.getStatus().roomId || syncManager.getRoomState())) {
      clearStartTime();
      if (syncManager.isRoomHost()) {
        const videoEl = getVideoElement(playerRef);
        hostResumedSrcRef.current = source.src; // o link já decidiu a posição: não retoma a da sala por cima
        if (videoEl && (videoEl.currentTime || 0) < 1) {
          const duration = Number.isFinite(videoEl.duration) ? videoEl.duration : Infinity;
          logger.info(`[Player] Abrindo em ${formatTime(startAt)} (link com ?t=)`);
          handleSeekRef.current(Math.min(startAt, Math.max(0, duration - 1)));
        }
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
  }, [readiness, autoPlay, paused, isConnected, isHost, roomId, confirmedPlayback, source.src,
    playerRef, handleSeekRef, lastKnownTimeRef, pendingPlayRef, setPaused, setPlaybackRate]);
}
