import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { logger } from '../../lib/logger';
import type { SubtitleTrack } from '../../types/media';
import { t } from '../../lib/i18n';

/** Atalhos de teclado do player (espaço/K, J/L, N, setas, M, F, Z, W, C, G/H, [ ]). Espectador não controla a reprodução. */
export function usePlayerShortcuts(a: {
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  paused: boolean;
  activeSubtitle: SubtitleTrack | null;
  detectedSubtitles: SubtitleTrack[];
  isFullscreen: boolean;
  syncStatus: { isConnected: boolean; isHost: boolean };
  skippableChapter: { targetTime: number; label: string } | null;
  subtitleDelay: number;
  audioDelay: number;
  lastKnownTimeRef: MutableRefObject<number>;
  setSyncToast: Dispatch<SetStateAction<string | null>>;
  setActiveSubtitle: Dispatch<SetStateAction<SubtitleTrack | null>>;
  triggerFullscreenVisuals: (active: boolean) => void;
  handlePlayToggle: () => void;
  handleSeek: (time: number) => void;
  handleVolumeChange: (volume: number) => void;
  handleMuteToggle: () => void;
  handleFullscreenToggle: () => void;
  handleToggleAspect: () => void;
  handleToggleWatchParty: () => void;
  handleSubtitleDelayChange: (delay: number) => void;
  handleAudioDelayChange: (delay: number) => void;
}) {
  const {
    currentTime, duration, volume, muted, paused, activeSubtitle, detectedSubtitles, isFullscreen, syncStatus, skippableChapter,
    subtitleDelay, audioDelay, lastKnownTimeRef, setSyncToast, setActiveSubtitle, triggerFullscreenVisuals,
    handlePlayToggle, handleSeek, handleVolumeChange, handleMuteToggle, handleFullscreenToggle, handleToggleAspect,
    handleToggleWatchParty, handleSubtitleDelayChange, handleAudioDelayChange,
  } = a;

  // Keyboard navigation shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const isViewer = syncStatus.isConnected && !syncStatus.isHost;

      switch (e.code) {
        case 'Escape':
          if (isFullscreen && !document.fullscreenElement) {
            e.preventDefault();
            triggerFullscreenVisuals(false);
          }
          break;
        case 'Space':
        case 'KeyK':
          e.preventDefault();
          if (isViewer) {
            setSyncToast(t('A reprodução é controlada pelo Host da sala'));
            setTimeout(() => setSyncToast(null), 2500);
            break;
          }
          handlePlayToggle();
          break;
        case 'KeyJ':
        case 'ArrowLeft': {
          e.preventDefault();
          if (isViewer) break;
          const baseTime = lastKnownTimeRef.current || currentTime;
          handleSeek(Math.max(0, baseTime - 10));
          logger.action('[Teclado] Voltar 10 s');
          break;
        }
        case 'KeyL':
        case 'ArrowRight': {
          e.preventDefault();
          if (isViewer) break;
          const baseTime = lastKnownTimeRef.current || currentTime;
          handleSeek(Math.min(duration || Infinity, baseTime + 10));
          logger.action('[Teclado] Avançar 10 s');
          break;
        }
        case 'KeyN':
        case 'KeyS':
        case 'KeyO':
          e.preventDefault();
          if (isViewer) break;
          // Com abertura/encerramento detectado, N pula o capítulo inteiro (igual ao botão flutuante)
          if (e.code === 'KeyN' && skippableChapter) {
            handleSeek(skippableChapter.targetTime);
            logger.action(`[Teclado] ${skippableChapter.label}`);
            break;
          }
          handleSeek(Math.min(duration || Infinity, currentTime + 90));
          logger.action('[Teclado] Pular 90 s');
          break;
        case 'ArrowUp':
          e.preventDefault();
          handleVolumeChange(Math.min(1, volume + 0.05));
          break;
        case 'ArrowDown':
          e.preventDefault();
          handleVolumeChange(Math.max(0, volume - 0.05));
          break;
        case 'KeyM':
          e.preventDefault();
          handleMuteToggle();
          break;
        case 'KeyF':
          e.preventDefault();
          handleFullscreenToggle();
          break;
        case 'KeyZ':
          e.preventDefault();
          handleToggleAspect();
          break;
        case 'KeyW':
          e.preventDefault();
          handleToggleWatchParty();
          break;
        case 'KeyC':
          e.preventDefault();
          if (activeSubtitle) {
            setActiveSubtitle(null);
          } else if (detectedSubtitles.length > 0) {
            setActiveSubtitle(detectedSubtitles[0]);
          }
          break;
        case 'KeyG':
          e.preventDefault();
          handleSubtitleDelayChange(Number((subtitleDelay - (e.shiftKey ? 0.25 : 0.05)).toFixed(2)));
          break;
        case 'KeyH':
          e.preventDefault();
          handleSubtitleDelayChange(Number((subtitleDelay + (e.shiftKey ? 0.25 : 0.05)).toFixed(2)));
          break;
        case 'BracketLeft':
          e.preventDefault();
          handleAudioDelayChange(Math.max(0, Number((audioDelay - (e.shiftKey ? 0.25 : 0.05)).toFixed(2))));
          break;
        case 'BracketRight':
          e.preventDefault();
          handleAudioDelayChange(Math.min(5.0, Number((audioDelay + (e.shiftKey ? 0.25 : 0.05)).toFixed(2))));
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    currentTime,
    duration,
    volume,
    muted,
    paused,
    activeSubtitle,
    detectedSubtitles,
    isFullscreen,
    syncStatus,
    skippableChapter,
    handleToggleWatchParty,
    subtitleDelay,
    audioDelay,
    handleSubtitleDelayChange,
    handleAudioDelayChange,
  ]);
}
