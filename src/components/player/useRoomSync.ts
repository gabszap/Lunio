import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import type { AudioTrackOption, PlaybackReadiness, SubtitleTrack } from '../../types/media';
import { formatTime } from '../../lib/chapters';
import { logger } from '../../lib/logger';
import { syncManager } from '../../lib/sync';
import { getDriftPlaybackRate } from '../../lib/playbackDrift';
import { syncDiagnostics } from '../../lib/syncDiagnostics';
import { getVideoElement } from './dom';
import type { PlayerSeek } from './usePlaybackControls';
import { t } from '../../lib/i18n';

export interface RoomSyncArgs {
  playerRef: RefObject<MediaPlayerInstance | null>;
  lastKnownTimeRef: MutableRefObject<number>;
  isSwitchingAudioRef: MutableRefObject<boolean>;
  isExplicitSeekingRef: MutableRefObject<boolean>;
  audioOffsetRef: MutableRefObject<number>;
  handleSeekRef: MutableRefObject<PlayerSeek>;
  paused: boolean;
  setPaused: Dispatch<SetStateAction<boolean>>;
  currentTime: number;
  playbackRate: number;
  setPlaybackRate: Dispatch<SetStateAction<number>>;
  readiness: PlaybackReadiness;
  isBuffering: boolean;
  sourceUrl: string;
  detectedAudioTracks: AudioTrackOption[];
  detectedSubtitles: SubtitleTrack[];
  onMediaChangeRequested?: (media: any) => void;
  isWatchPartyOpen?: boolean;
  onToggleWatchParty?: () => void;
  onCloseWatchParty?: () => void;
}

/**
 * Tudo que liga o player à sala (Watch Party): painel aberto/fechado, eventos do WebSocket (play/pause/seek/rate/mídia/chat),
 * timeline do Host, correção de drift do espectador e aviso de prontidão. Playback é Host-autoritativo.
 */
export function useRoomSync(args: RoomSyncArgs) {
  const {
    playerRef,
    lastKnownTimeRef,
    isSwitchingAudioRef,
    isExplicitSeekingRef,
    audioOffsetRef,
    handleSeekRef,
    paused,
    setPaused,
    currentTime,
    playbackRate,
    setPlaybackRate,
    readiness,
    isBuffering,
    sourceUrl,
    detectedAudioTracks,
    detectedSubtitles,
    onMediaChangeRequested,
    isWatchPartyOpen: propIsWatchPartyOpen,
    onToggleWatchParty,
    onCloseWatchParty,
  } = args;

  // Watch Party & Sincronização em tempo real (Fase 6)
  const [internalWatchPartyOpen, setInternalWatchPartyOpen] = useState<boolean>(false);
  const isWatchPartyOpen = propIsWatchPartyOpen !== undefined ? propIsWatchPartyOpen : internalWatchPartyOpen;

  const handleToggleWatchParty = useCallback(() => {
    if (onToggleWatchParty) {
      onToggleWatchParty();
    } else {
      setInternalWatchPartyOpen((prev) => !prev);
    }
  }, [onToggleWatchParty]);

  const handleCloseWatchParty = useCallback(() => {
    if (onCloseWatchParty) {
      onCloseWatchParty();
    } else if (onToggleWatchParty && isWatchPartyOpen) {
      onToggleWatchParty();
    } else {
      setInternalWatchPartyOpen(false);
    }
  }, [onCloseWatchParty, onToggleWatchParty, isWatchPartyOpen]);

  const [syncToast, setSyncToast] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState(() => syncManager.getStatus());
  const [hostPausedInfo, setHostPausedInfo] = useState<{ username: string } | null>(null);
  const [chatToasts, setChatToasts] = useState<Array<{ id: string; username: string; text: string; avatarUrl?: string }>>([]);
  const isWatchPartyOpenRef = useRef<boolean>(isWatchPartyOpen);
  isWatchPartyOpenRef.current = isWatchPartyOpen;

  useEffect(() => {
    if (isWatchPartyOpen) {
      setChatToasts([]);
    }
  }, [isWatchPartyOpen]);

  // Conexão e escuta de eventos do WebSocket de Watch Party
  useEffect(() => {
    // Registra getter de playhead real para telemetria de heartbeat (sem mutar playback global)
    syncManager.registerTimeGetter(() => {
      const videoEl = getVideoElement(playerRef);
      if (!videoEl) return lastKnownTimeRef.current;
      return videoEl.currentTime + (isSwitchingAudioRef.current ? audioOffsetRef.current : 0);
    });

    const unsubState = syncManager.subscribeState(() => {
      setSyncStatus(syncManager.getStatus());
    });

    const unsubPlayback = syncManager.subscribePlayback(
      (action, position, rate, triggeredBy, username) => {
        const videoEl = getVideoElement(playerRef);

        const isSelf = triggeredBy === syncManager.getUser().id;
        const roomPlayback = { playing: syncManager.getRoomState()?.playback.playing ?? false };

        if (action === 'play') {
          setHostPausedInfo(null);
          if (!isSelf) {
            const cur = isSwitchingAudioRef.current
              ? (videoEl ? videoEl.currentTime : 0) + audioOffsetRef.current
              : (videoEl?.currentTime ?? currentTime);
            if (Math.abs(cur - position) > 1.5) {
              handleSeekRef.current(position, roomPlayback);
            }
          }
          if (videoEl && videoEl.paused) {
            videoEl.play().catch(() => {});
          }
          setPaused(false);
          setSyncToast(t('{username} deu play', { username }));
          setTimeout(() => setSyncToast(null), 3000);
        } else if (action === 'pause') {
          setHostPausedInfo({ username });
          if (videoEl && !videoEl.paused) {
            try {
              videoEl.pause();
            } catch {}
          }
          setPaused(true);
          if (!isSelf) {
            const cur = isSwitchingAudioRef.current
              ? (videoEl ? videoEl.currentTime : 0) + audioOffsetRef.current
              : (videoEl?.currentTime ?? currentTime);
            if (Math.abs(cur - position) > 1.5) {
              handleSeekRef.current(position, roomPlayback);
            }
          }
          setSyncToast(t('{username} pausou o vídeo', { username }));
          setTimeout(() => setSyncToast(null), 3000);
        } else if (action === 'seek') {
          if (!isSelf) {
            handleSeekRef.current(position, roomPlayback);
          }
          setSyncToast(t('{username} buscou para {v1}', { username, v1: formatTime(position) }));
          setTimeout(() => setSyncToast(null), 3000);
        } else if (action === 'rate') {
          if (videoEl) videoEl.playbackRate = rate;
          if (playerRef.current) playerRef.current.playbackRate = rate;
          setPlaybackRate(rate);
          setSyncToast(t('{username} alterou velocidade: {rate}x', { username, rate }));
          setTimeout(() => setSyncToast(null), 3000);
        }
      }
    );

    const unsubMedia = syncManager.subscribeMedia((media, generation, triggeredBy, username) => {
      if (media && !syncManager.isRoomHost()) {
        setSyncToast(t('{username} carregou: {title}', { username, title: media.title || t('novo vídeo') }));
        setTimeout(() => setSyncToast(null), 4000);
        onMediaChangeRequested?.(media);
      }
    });

    const unsubChat = syncManager.subscribeChat((msg) => {
      if (msg.isSystem) return;
      const currentUserId = syncManager.getUser().id;
      if (msg.userId === currentUserId) return;

      if (!isWatchPartyOpenRef.current) {
        const toastId = msg.id || `${Date.now()}_${Math.random()}`;
        const newToast = { id: toastId, username: msg.username, text: msg.text, avatarUrl: msg.avatarUrl };
        setChatToasts((prev) => {
          const updated = [...prev, newToast];
          return updated.slice(-3); // Exibe no máximo as 3 mensagens mais recentes
        });
        setTimeout(() => {
          setChatToasts((prev) => prev.filter((t) => t.id !== toastId));
        }, 4500);
      }
    });

    const unsubError = syncManager.subscribeError((_errorMsg, code) => {
      if (code === 'banned') {
        setSyncToast(t('Você foi banido da sala pelo Host.'));
      } else if (code === 'kicked') {
        setSyncToast(t('Você foi expulso da sala pelo Host.'));
      }
    });

    return () => {
      syncManager.registerTimeGetter(null as any);
      unsubState();
      unsubPlayback();
      unsubMedia();
      unsubChat();
      unsubError();
    };
  }, [detectedAudioTracks, detectedSubtitles, currentTime, onMediaChangeRequested]);

  // Host: Emissão contínua da timeline real para sincronizar autoritativamente os espectadores (evita que o espectador se antecipe)
  useEffect(() => {
    if (paused || !syncStatus.isConnected || !syncStatus.isHost) return;
    const interval = setInterval(() => {
      const videoEl = getVideoElement(playerRef);
      const curTime = videoEl
        ? videoEl.currentTime + (isSwitchingAudioRef.current ? audioOffsetRef.current : 0)
        : lastKnownTimeRef.current;
      syncManager.emitHostTimeline(curTime, playbackRate);
    }, 1000);
    return () => clearInterval(interval);
  }, [paused, syncStatus.isConnected, syncStatus.isHost, playbackRate]);

  // Espectador: corrige o desvio em relação à timeline do Host.
  useEffect(() => {
    if (paused || isBuffering || !syncStatus.isConnected || syncStatus.isHost) return;
    const interval = setInterval(() => {
      const videoEl = getVideoElement(playerRef);
      const roomState = syncManager.getRoomState();
      if (!videoEl || videoEl.paused || videoEl.seeking || isExplicitSeekingRef.current || videoEl.readyState < 3) return;
      if (!roomState?.playback.playing || !syncManager.getConfirmedPlayback(sourceUrl)) return;

      const curTime = videoEl.currentTime + (isSwitchingAudioRef.current ? audioOffsetRef.current : 0);
      const driftRes = syncManager.calculateDrift(curTime);

      if (driftRes.action === 'seek') {
        logger.info(`[Sala] Fora de sincronia por ${Math.abs(driftRes.drift).toFixed(1).replace('.', ',')} s; ajustando para ${formatTime(driftRes.targetTime)}`);
        handleSeekRef.current(driftRes.targetTime, { playing: true });
      } else {
        const nextRate = getDriftPlaybackRate(driftRes.action, roomState.playback.rate);
        if (videoEl.playbackRate !== nextRate) videoEl.playbackRate = nextRate;
      }
      syncDiagnostics?.recordDrift(driftRes, videoEl.playbackRate);
    }, 800);
    return () => clearInterval(interval);
  }, [paused, isBuffering, syncStatus.isConnected, syncStatus.isHost, sourceUrl, isExplicitSeekingRef]);

  // Notificação de prontidão do membro para a sala ao mudar de estado
  const confirmedPlayback = syncManager.getConfirmedPlayback(sourceUrl);
  const isSubReady =
    !readiness.selectedSubtitle.enabled ||
    !readiness.selectedSubtitle.required ||
    (readiness.selectedSubtitle.ready && !readiness.selectedSubtitle.failed);
  const hasRequiredTracks = readiness.video && readiness.audio && isSubReady;
  useEffect(() => {
    if (!confirmedPlayback || syncManager.getConfirmedPlayback(sourceUrl) !== confirmedPlayback) return;
    const videoEl = getVideoElement(playerRef);
    const isPaused = videoEl?.paused ?? paused;
    const state = !hasRequiredTracks ? 'loading' : isBuffering ? 'stalled' : isPaused ? 'paused' : 'playing';
    syncDiagnostics?.recordState(state);
    syncManager.emitReadiness(hasRequiredTracks && !isBuffering, state, lastKnownTimeRef.current || 0, confirmedPlayback.generation);
  }, [confirmedPlayback, sourceUrl, hasRequiredTracks, isBuffering, paused, playerRef, lastKnownTimeRef]);

  return {
    isWatchPartyOpen,
    handleToggleWatchParty,
    handleCloseWatchParty,
    syncToast,
    setSyncToast,
    syncStatus,
    hostPausedInfo,
    chatToasts,
    setChatToasts,
  };
}
