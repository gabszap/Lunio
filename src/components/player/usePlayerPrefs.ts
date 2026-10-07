import { useCallback, useRef, useState } from 'react';
import { audioBoost } from '../../lib/audioBoost';
import { logger } from '../../lib/logger';
import { subtitleManager } from '../../lib/subtitles';

export type AspectMode = 'fit' | 'stretch' | 'fill';

/** Preferências locais do player (nada disso vai para a sala): ganho, atrasos, tamanho da legenda, ajuste de tela e o OSD. */
export function usePlayerPrefs() {
  const [aspectMode, setAspectMode] = useState<AspectMode>('fit');
  const [aspectToast, setAspectToast] = useState<string | null>(null);
  const [volumeBoost, setVolumeBoost] = useState<number>(() => audioBoost.getBoost());
  const [audioDelay, setAudioDelay] = useState<number>(() => audioBoost.getAudioDelay());
  const [subtitleDelay, setSubtitleDelay] = useState<number>(() => subtitleManager.getSubtitleDelay());
  const [subtitleFontSize, setSubtitleFontSize] = useState<number>(() => subtitleManager.getFontSize());
  const [osdToast, setOsdToast] = useState<{ text: string; icon?: string } | null>(null);
  const osdToastTimerRef = useRef<number | null>(null);

  const triggerOsdToast = useCallback((text: string, icon?: string) => {
    if (osdToastTimerRef.current) {
      window.clearTimeout(osdToastTimerRef.current);
    }
    setOsdToast({ text, icon });
    osdToastTimerRef.current = window.setTimeout(() => {
      setOsdToast(null);
    }, 1600);
  }, []);

  const handleAudioDelayChange = useCallback((delay: number) => {
    const clamped = Math.max(0, Math.min(5.0, Number(delay.toFixed(2))));
    audioBoost.setAudioDelay(clamped);
    setAudioDelay(clamped);
    const ms = Math.round(clamped * 1000);
    triggerOsdToast(ms === 0 ? 'Atraso do áudio: 0 ms' : `Atraso do áudio: +${ms} ms`);
  }, [triggerOsdToast]);

  const handleSubtitleDelayChange = useCallback((delay: number) => {
    const clamped = Math.max(-10.0, Math.min(10.0, Number(delay.toFixed(2))));
    subtitleManager.setSubtitleDelay(clamped);
    setSubtitleDelay(clamped);
    const ms = Math.round(clamped * 1000);
    triggerOsdToast(ms === 0 ? 'Sincronia da legenda: 0 ms' : `Sincronia da legenda: ${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms`);
  }, [triggerOsdToast]);

  const handleSubtitleFontSizeChange = useCallback((size: number) => {
    subtitleManager.setFontSize(size);
    setSubtitleFontSize(size);
    triggerOsdToast(`Tamanho da legenda: ${size}%`);
  }, [triggerOsdToast]);

  // Alternar Aspect Ratio (Original / Esticar / Preencher - estilo mpv & Stremio)
  const handleToggleAspect = () => {
    setAspectMode((prev) => {
      let next: AspectMode = 'fit';
      let label = 'Ajuste de tela: original';
      if (prev === 'fit') {
        next = 'stretch';
        label = 'Ajuste de tela: esticar';
      } else if (prev === 'stretch') {
        next = 'fill';
        label = 'Ajuste de tela: preencher';
      } else {
        next = 'fit';
        label = 'Ajuste de tela: original';
      }
      setAspectToast(label);
      setTimeout(() => setAspectToast((curr) => (curr === label ? null : curr)), 2500);
      logger.action(`[Player] ${label}`);
      setTimeout(() => subtitleManager.resize(), 50);
      setTimeout(() => subtitleManager.resize(), 200);
      return next;
    });
  };

  return {
    aspectMode,
    aspectToast,
    handleToggleAspect,
    volumeBoost,
    setVolumeBoost,
    audioDelay,
    subtitleDelay,
    subtitleFontSize,
    osdToast,
    handleAudioDelayChange,
    handleSubtitleDelayChange,
    handleSubtitleFontSizeChange,
  };
}
