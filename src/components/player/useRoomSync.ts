import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import type { AudioTrackOption, PlaybackReadiness, SubtitleTrack } from '../../types/media';
import { formatTime } from '../../lib/chapters';
import { logger } from '../../lib/logger';
import { syncManager } from '../../lib/sync';
import { getVideoElement } from './dom';

export interface RoomSyncArgs {
  playerRef: RefObject<MediaPlayerInstance | null>;
  lastKnownTimeRef: MutableRefObject<number>;
  isSwitchingAudioRef: MutableRefObject<boolean>;
  audioOffsetRef: MutableRefObject<number>;
  handleSeekRef: MutableRefObject<(time: number) => void>;
  paused: boolean;
  setPaused: Dispatch<SetStateAction<boolean>>;
  currentTime: number;
  playbackRate: number;
  setPlaybackRate: Dispatch<SetStateAction<number>>;
  readiness: PlaybackReadiness;
  isBuffering: boolean;
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
    audioOffsetRef,
    handleSeekRef,
    paused,
    setPaused,
    currentTime,
    playbackRate,
    setPlaybackRate,
    readiness,
    isBuffering,
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
  const [unreadChatCount, setUnreadChatCount] = useState<number>(0);
  const [chatToasts, setChatToasts] = useState<Array<{ id: string; username: string; text: string; avatarUrl?: string }>>([]);
  const isWatchPartyOpenRef = useRef<boolean>(isWatchPartyOpen);
  isWatchPartyOpenRef.current = isWatchPartyOpen;

  useEffect(() => {
    if (isWatchPartyOpen) {
      setUnreadChatCount(0);
      setChatToasts([]);
    }
  }, [isWatchPartyOpen]);

  // Conexão e escuta de eventos do WebSocket de Watch Party
  useEffect(() => {
    // Registra getter de playhead real para telemetria de heartbeat (sem mutar playback global)
    syncManager.registerTimeGetter(() => {
      const videoEl = getVideoElement(playerRef);
      const vidCur = videoEl?.currentTime || lastKnownTimeRef.current || 0;
      return isSwitchingAudioRef.current ? vidCur + audioOffsetRef.current : vidCur;
    });

    const unsubState = syncManager.subscribeState(() => {
      setSyncStatus(syncManager.getStatus());
    });

    const unsubPlayback = syncManager.subscribePlayback(
      (action, position, rate, triggeredBy, username) => {
        const videoEl = getVideoElement(playerRef);

        const isSelf = triggeredBy === syncManager.getUser().id;

        if (action === 'play') {
          setHostPausedInfo(null);
          if (!isSelf) {
            const cur = isSwitchingAudioRef.current
              ? (videoEl ? videoEl.currentTime : 0) + audioOffsetRef.current
              : (videoEl?.currentTime ?? currentTime);
            if (Math.abs(cur - position) > 1.5) {
              handleSeekRef.current(position);
            }
          }
          if (videoEl && videoEl.paused) {
            videoEl.play().catch(() => {});
          }
          setPaused(false);
          setSyncToast(`${username} deu play`);
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
              handleSeekRef.current(position);
            }
          }
          setSyncToast(`${username} pausou o vídeo`);
          setTimeout(() => setSyncToast(null), 3000);
        } else if (action === 'seek') {
          if (!isSelf) {
            handleSeekRef.current(position);
          }
          setSyncToast(`${username} buscou para ${formatTime(position)}`);
          setTimeout(() => setSyncToast(null), 3000);
        } else if (action === 'rate') {
          if (videoEl) videoEl.playbackRate = rate;
          if (playerRef.current) playerRef.current.playbackRate = rate;
          setPlaybackRate(rate);
          setSyncToast(`${username} alterou velocidade: ${rate}x`);
          setTimeout(() => setSyncToast(null), 3000);
        }
      }
    );

    const unsubMedia = syncManager.subscribeMedia((media, generation, triggeredBy, username) => {
      if (media && !syncManager.isRoomHost()) {
        setSyncToast(`${username} carregou: ${media.title || 'novo vídeo'}`);
        setTimeout(() => setSyncToast(null), 4000);
        onMediaChangeRequested?.(media);
      }
    });

    const unsubChat = syncManager.subscribeChat((msg) => {
      if (msg.isSystem) return;
      const currentUserId = syncManager.getUser().id;
      if (msg.userId === currentUserId) return;

      if (!isWatchPartyOpenRef.current) {
        setUnreadChatCount((prev) => prev + 1);
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
        setSyncToast('Você foi banido da sala pelo Host.');
      } else if (code === 'kicked') {
        setSyncToast('Você foi expulso da sala pelo Host.');
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
      const curTime =
        (videoEl?.currentTime || lastKnownTimeRef.current || 0) +
        (isSwitchingAudioRef.current ? audioOffsetRef.current : 0);
      syncManager.emitHostTimeline(curTime, playbackRate);
    }, 1000);
    return () => clearInterval(interval);
  }, [paused, syncStatus.isConnected, syncStatus.isHost, playbackRate]);

  // Espectador: Drift Correction contínuo & calibração precisa da timeline (imede que o espectador fique na frente do Host)
  useEffect(() => {
    if (paused || !syncStatus.isConnected || syncStatus.isHost) return;
    const interval = setInterval(() => {
      const videoEl = getVideoElement(playerRef);
      if (!videoEl || videoEl.paused) return;

      const curTime =
        (videoEl.currentTime || lastKnownTimeRef.current || 0) +
        (isSwitchingAudioRef.current ? audioOffsetRef.current : 0);
      const driftRes = syncManager.calculateDrift(curTime);

      if (driftRes.action === 'seek') {
        logger.info(`[Sala] Fora de sincronia por ${Math.abs(driftRes.drift).toFixed(1).replace('.', ',')} s; ajustando para ${formatTime(driftRes.targetTime)}`);
        handleSeekRef.current(driftRes.targetTime);
      } else if (driftRes.action === 'rate_slowdown') {
        // Espectador adiantado: desacelera para 0.85x para o Host alcançar rápido
        videoEl.playbackRate = playbackRate * 0.85;
      } else if (driftRes.action === 'rate_speedup') {
        // Espectador atrasado: micro-aceleração para 1.08x
        videoEl.playbackRate = playbackRate * 1.08;
      } else {
        if (videoEl.playbackRate !== playbackRate) {
          videoEl.playbackRate = playbackRate;
        }
      }
    }, 800);
    return () => clearInterval(interval);
  }, [paused, syncStatus.isConnected, syncStatus.isHost, playbackRate]);

  // Notificação de prontidão do membro para a sala ao mudar de estado
  useEffect(() => {
    const isSubReady =
      !readiness.selectedSubtitle.enabled ||
      !readiness.selectedSubtitle.required ||
      (readiness.selectedSubtitle.ready && !readiness.selectedSubtitle.failed);
    const isReady = readiness.video && readiness.audio && isSubReady;
    syncManager.emitReadiness(
      isReady,
      isBuffering ? 'loading' : paused ? 'paused' : 'playing',
      lastKnownTimeRef.current || 0
    );
  }, [readiness, isBuffering, paused]);

  return {
    isWatchPartyOpen,
    handleToggleWatchParty,
    handleCloseWatchParty,
    syncToast,
    setSyncToast,
    syncStatus,
    hostPausedInfo,
    unreadChatCount,
    chatToasts,
    setChatToasts,
  };
}
