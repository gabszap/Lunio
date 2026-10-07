import { useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import type { AudioTrackOption, Chapter, SubtitleTrack } from '../../types/media';
import { audioBoost } from '../../lib/audioBoost';
import { formatTime } from '../../lib/chapters';
import { logger } from '../../lib/logger';
import { sessionManager } from '../../lib/session';
import { syncManager } from '../../lib/sync';
import { getVideoElement } from './dom';

/**
 * Ações do usuário sobre a reprodução: play/pause, seek (nativo, por buffer ou refazendo o remux), volume, mudo,
 * velocidade, ganho e "continuar de onde parou". Só o Host da sala emite play/pause/seek/velocidade.
 */
export function usePlaybackControls(args: {
  playerRef: RefObject<MediaPlayerInstance | null>;
  source: { src: string };
  title?: string;
  mediaTitle: string;
  duration: number;
  currentTime: number;
  paused: boolean;
  muted: boolean;
  syncStatus: { isConnected: boolean; isHost: boolean };
  detectedChapters: Chapter[];
  detectedSubtitles: SubtitleTrack[];
  detectedAudioTracks: AudioTrackOption[];
  resumePrompt: { time: number; formatted: string } | null;
  remuxFrom: (targetTime: number) => void;
  isSwitchingAudioRef: MutableRefObject<boolean>;
  audioOffsetRef: MutableRefObject<number>;
  wasPlayingBeforeAudioSwitchRef: MutableRefObject<boolean>;
  wasPlayingBeforeSeekRef: MutableRefObject<boolean>;
  pendingPlayRef: MutableRefObject<boolean>;
  lastKnownTimeRef: MutableRefObject<number>;
  isExplicitSeekingRef: MutableRefObject<boolean>;
  handleSeekRef: MutableRefObject<(time: number) => void>;
  setPaused: Dispatch<SetStateAction<boolean>>;
  setCurrentTime: Dispatch<SetStateAction<number>>;
  setIsBuffering: Dispatch<SetStateAction<boolean>>;
  setResumePrompt: Dispatch<SetStateAction<{ time: number; formatted: string } | null>>;
  setSyncToast: Dispatch<SetStateAction<string | null>>;
  setVolume: Dispatch<SetStateAction<number>>;
  setMuted: Dispatch<SetStateAction<boolean>>;
  setPlaybackRate: Dispatch<SetStateAction<number>>;
  setVolumeBoost: Dispatch<SetStateAction<number>>;
}) {
  const {
    playerRef, source, title, mediaTitle, duration, currentTime, paused, muted, syncStatus,
    detectedChapters, detectedSubtitles, detectedAudioTracks, resumePrompt, remuxFrom,
    isSwitchingAudioRef, audioOffsetRef, wasPlayingBeforeAudioSwitchRef, wasPlayingBeforeSeekRef, pendingPlayRef,
    lastKnownTimeRef, isExplicitSeekingRef, handleSeekRef,
    setPaused, setCurrentTime, setIsBuffering, setResumePrompt, setSyncToast, setVolume, setMuted, setPlaybackRate, setVolumeBoost,
  } = args;

  // Auto-dismiss do banner de retomada após 12 segundos
  useEffect(() => {
    if (!resumePrompt) return;
    const timer = setTimeout(() => {
      setResumePrompt(null);
    }, 12000);
    return () => clearTimeout(timer);
  }, [resumePrompt]);

  // Ação disparada ao clicar no botão 'Retomar' do banner
  const handleResumePlayback = () => {
    if (!resumePrompt) return;
    const target = resumePrompt.time;
    logger.action(`[Player] Continuando de ${resumePrompt.formatted}`);
    setResumePrompt(null);
    handleSeek(target);
    const videoEl = getVideoElement(playerRef);
    if (videoEl && videoEl.paused) {
      videoEl.play().catch(() => {});
    }
  };

  // Control handlers
  const handlePlayToggle = () => {
    if (syncStatus.isConnected && !syncStatus.isHost) {
      setSyncToast('A reprodução é controlada pelo Host da sala');
      setTimeout(() => setSyncToast(null), 2500);
      return;
    }

    const videoEl = getVideoElement(playerRef);

    const isCurrentlyPaused = videoEl ? videoEl.paused : (playerRef.current ? playerRef.current.paused : paused);

    if (isCurrentlyPaused) {
      if (!syncManager.isApplyingRemoteUpdate && syncManager.isRoomHost()) {
        const cur = isSwitchingAudioRef.current
          ? (videoEl ? videoEl.currentTime : 0) + audioOffsetRef.current
          : (videoEl?.currentTime ?? currentTime);
        if (source.src) {
          const currentRoomMedia = syncManager.getRoomState()?.media;
          if (!currentRoomMedia || currentRoomMedia.url !== source.src) {
            syncManager.emitMedia({
              url: source.src,
              title: mediaTitle || title || 'Vídeo',
              duration: duration || 0,
              chapters: detectedChapters,
              subtitles: detectedSubtitles,
              audioTracks: detectedAudioTracks,
            }, cur);
          }
        }
        syncManager.emitPlay(cur);
      }
      wasPlayingBeforeAudioSwitchRef.current = true;
      pendingPlayRef.current = true;
      setPaused(false);

      // 1. Prioriza o elemento nativo HTML5, que enfileira o play de forma resiliente mesmo antes de can-play
      if (videoEl) {
        videoEl.play().then(() => {
          pendingPlayRef.current = false;
        }).catch((err) => {
          if (err?.name === 'AbortError' || err?.name === 'NotAllowedError') return;
          // Se ainda estiver carregando primeiros pacotes, onCanPlay dará play automaticamente
        });
      } else if (playerRef.current && (playerRef.current as any).state?.canPlay) {
        // 2. Se for via Vidstack, só chama se canPlay já estiver confirmado para não lançar exceção
        playerRef.current.play().then(() => {
          pendingPlayRef.current = false;
        }).catch((err) => {
          if (err?.name === 'AbortError' || err?.message?.includes('can-play')) return;
          logger.warn('[Player] O navegador bloqueou o play:', err);
        });
      }
    } else {
      if (!syncManager.isApplyingRemoteUpdate && syncManager.isRoomHost()) {
        const cur = isSwitchingAudioRef.current
          ? (videoEl ? videoEl.currentTime : 0) + audioOffsetRef.current
          : (videoEl?.currentTime ?? currentTime);
        syncManager.emitPause(cur);
      }
      wasPlayingBeforeAudioSwitchRef.current = false;
      pendingPlayRef.current = false;
      setPaused(true);
      if (videoEl) {
        try { videoEl.pause(); } catch {}
      }
      if (playerRef.current) {
        try { playerRef.current.pause(); } catch {}
      }
    }
  };

  const handleSeek = (newTime: number) => {
    if (!syncManager.isApplyingRemoteUpdate && syncStatus.isConnected && !syncStatus.isHost) {
      return;
    }

    const videoEl = getVideoElement(playerRef);

    wasPlayingBeforeSeekRef.current = videoEl ? !videoEl.paused : !paused;

    const targetTime = Math.max(0, newTime);
    if (!syncManager.isApplyingRemoteUpdate && syncManager.isRoomHost()) {
      syncManager.emitSeek(targetTime);
    }
    setResumePrompt(null);
    lastKnownTimeRef.current = targetTime;
    isExplicitSeekingRef.current = true;
    setTimeout(() => {
      isExplicitSeekingRef.current = false;
    }, 1500);

    // 1. Dublagem alternativa ativa com FFmpeg remux: Remuxa segmento físico a partir de targetTime
    // (Streams fMP4 chunked sem suporte a range não suportam seek confiável no elemento <video>; o FFmpeg garante precisão absoluta)
    if (isSwitchingAudioRef.current) {
      remuxFrom(targetTime);
      return;
    }

    // 2. CHECAGEM DE BUFFER: Verifica se o ponto desejado já está na memória RAM do navegador (Modo nativo Range 206)
    let isInsideBuffer = false;
    if (videoEl && videoEl.buffered && videoEl.buffered.length > 0 && targetTime >= 0) {
      const b = videoEl.buffered;
      for (let i = 0; i < b.length; i++) {
        // Tolerância de 0.3s nas bordas
        if (targetTime >= b.start(i) - 0.2 && targetTime <= b.end(i) - 0.3) {
          isInsideBuffer = true;
          break;
        }
      }
    }

    // Fase 3 (Regions & Cold Seek): Avalia Warm Seek vs Cold Seek com cancelamento de geração e nova região de 30s
    sessionManager.evaluateSeek(targetTime, isInsideBuffer);

    if (isInsideBuffer) {
      if (videoEl) {
        videoEl.currentTime = targetTime;
      } else if (playerRef.current) {
        playerRef.current.currentTime = targetTime;
      }
      setCurrentTime(targetTime);
      setIsBuffering(false);
      sessionManager.updateRunStatus('ready');
      logger.action(`[Player] Pulando para ${formatTime(targetTime)} (já carregado)`);
      return;
    }

    // 3. Streaming direto Range 206 (padrão): Seek 100% nativo sem recarregar URL nem resetar player
    if (videoEl) {
      videoEl.currentTime = targetTime;
    } else if (playerRef.current) {
      playerRef.current.currentTime = targetTime;
    }
    setCurrentTime(targetTime);
    sessionManager.updateRunStatus('running');
    logger.action(`[Player] Pulando para ${formatTime(targetTime)}`);
  };

  const handleVolumeChange = (newVolume: number) => {
    if (!playerRef.current) return;
    playerRef.current.volume = newVolume;
    setVolume(newVolume);
    localStorage.setItem('vidstack_player_volume', newVolume.toString());
  };

  const handleMuteToggle = () => {
    if (!playerRef.current) return;
    const nextMuted = !muted;
    playerRef.current.muted = nextMuted;
    setMuted(nextMuted);
    localStorage.setItem('vidstack_player_muted', String(nextMuted));
    logger.action(nextMuted ? '[Player] Som desligado' : '[Player] Som ligado');
  };

  const handlePlaybackRateChange = (newRate: number) => {
    if (!syncManager.isApplyingRemoteUpdate && syncManager.isRoomHost()) {
      syncManager.emitRate(newRate);
    }
    if (!playerRef.current) return;
    playerRef.current.playbackRate = newRate;
    setPlaybackRate(newRate);
    localStorage.setItem('vidstack_player_rate', newRate.toString());
  };

  handleSeekRef.current = handleSeek;

  const handleVolumeBoostChange = (newBoost: number) => {
    setVolumeBoost(newBoost);
    audioBoost.setBoost(newBoost);
  };

  return {
    handleResumePlayback,
    handlePlayToggle,
    handleSeek,
    handleVolumeChange,
    handleMuteToggle,
    handlePlaybackRateChange,
    handleVolumeBoostChange,
  };
}
