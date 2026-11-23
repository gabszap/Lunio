import { useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import type { Chapter } from '../../types/media';
import { getCurrentChapter, formatTime } from '../../lib/chapters';
import { logger } from '../../lib/logger';
import { sessionManager } from '../../lib/session';
import { getProgressStorageKey } from './progress';
import { reportProgress } from '../../lib/continueWatching';

const YT_QUALITY_LABELS: Record<string, string> = {
  highres: '4K+',
  hd2160: '4K',
  hd1440: '1440p',
  hd1080: '1080p',
  hd720: '720p',
  large: '480p',
  medium: '360p',
  small: '240p',
  tiny: '144p',
};

function formatVideoHeight(height: number): string | null {
  if (!Number.isFinite(height) || height <= 0) return null;
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  if (height >= 360) return '360p';
  return `${Math.round(height)}p`;
}

/**
 * Ouve o <video> nativo (imune a dessincronias do Vidstack): tempo, buffer, pause/play, seek, capítulo atual,
 * progresso salvo e a recuperação do remux que "volta ao começo" depois de um pause.
 */
export function useNativeVideoEvents(args: {
  playerRef: RefObject<MediaPlayerInstance | null>;
  resolvedStreamUrl: string;
  source: { src: string };
  resumePrompt: { time: number; formatted: string } | null;
  isSwitchingAudioRef: MutableRefObject<boolean>;
  audioOffsetRef: MutableRefObject<number>;
  totalDurationRef: MutableRefObject<number>;
  isExplicitSeekingRef: MutableRefObject<boolean>;
  lastKnownTimeRef: MutableRefObject<number>;
  wasPlayingBeforeSeekRef: MutableRefObject<boolean>;
  handleSeekRef: MutableRefObject<(time: number) => void>;
  currentChapterRef: MutableRefObject<Chapter | null>;
  normalizedChaptersRef: MutableRefObject<Chapter[]>;
  setBuffered: Dispatch<SetStateAction<number>>;
  setBufferedRanges: Dispatch<SetStateAction<{ start: number; end: number }[]>>;
  setCurrentTime: Dispatch<SetStateAction<number>>;
  setPaused: Dispatch<SetStateAction<boolean>>;
  setIsBuffering: Dispatch<SetStateAction<boolean>>;
  setResumePrompt: Dispatch<SetStateAction<{ time: number; formatted: string } | null>>;
  setLiveResolution?: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    playerRef, resolvedStreamUrl, source, resumePrompt,
    isSwitchingAudioRef, audioOffsetRef, totalDurationRef, isExplicitSeekingRef, lastKnownTimeRef, wasPlayingBeforeSeekRef,
    handleSeekRef, currentChapterRef, normalizedChaptersRef,
    setBuffered, setBufferedRanges, setCurrentTime, setPaused, setIsBuffering, setResumePrompt, setLiveResolution,
  } = args;

  const resumePromptRef = useRef(resumePrompt);
  resumePromptRef.current = resumePrompt;

  // Detecta qualidade ao vivo no YouTube via postMessage oficial do iframe (onPlaybackQualityChange / infoDelivery)
  useEffect(() => {
    setLiveResolution?.(null);
    if (!resolvedStreamUrl.startsWith('youtube/') || !setLiveResolution) return;
    const onMessage = (event: MessageEvent) => {
      if (typeof event.origin !== 'string' || !/^https:\/\/www\.youtube(-nocookie)?\.com$/i.test(event.origin)) return;
      let payload: any = event.data;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          return;
        }
      }
      if (!payload || typeof payload !== 'object') return;
      const rawQuality =
        payload.event === 'onPlaybackQualityChange' && typeof payload.info === 'string'
          ? payload.info
          : typeof payload.info?.playbackQuality === 'string'
          ? payload.info.playbackQuality
          : null;
      if (rawQuality && Object.hasOwn(YT_QUALITY_LABELS, rawQuality)) {
        setLiveResolution(YT_QUALITY_LABELS[rawQuality]);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [resolvedStreamUrl, setLiveResolution]);

  // Sincronização direta e contínua do elemento <video> nativo (imune a dessincronias do Vidstack)
  useEffect(() => {
    if (!resolvedStreamUrl || resolvedStreamUrl.startsWith('youtube/')) return;
    let active = true;
    let videoEl: HTMLVideoElement | null = null;
    let retryTimer: any = null;
    let retryCount = 0;

    const updateBufferInfo = () => {
      if (!videoEl) return;
      const b = videoEl.buffered;
      const offset = isSwitchingAudioRef.current ? audioOffsetRef.current : 0;
      const cur = (videoEl.currentTime || 0) + offset;

      if (!b || b.length === 0) {
        if (totalDurationRef.current > 0) {
          // Mantém os ranges conhecidos durante stalls momentâneos para não piscar 0 na UI
          return;
        }
        setBuffered(offset);
        setBufferedRanges([]);
        return;
      }

      const ranges: { start: number; end: number }[] = [];
      for (let i = 0; i < b.length; i++) {
        ranges.push({
          start: Math.max(0, b.start(i) + offset),
          end: Math.max(0, b.end(i) + offset),
        });
      }
      setBufferedRanges(ranges);

      // Encontra o segmento que engloba a posição atual de reprodução com tolerância generosa
      const activeRange = ranges.find((r) => cur >= r.start - 2.0 && cur <= r.end + 1.5);
      let bufferAhead = 0;
      if (activeRange) {
        setBuffered(activeRange.end);
        bufferAhead = Math.max(0, activeRange.end - cur);
      } else {
        // Se o usuário buscou para frente além dos dados anteriores:
        // Procura se já há um range carregado à frente
        const nextRange = ranges.find((r) => r.end > cur);
        if (nextRange) {
          setBuffered(nextRange.end);
          bufferAhead = Math.max(0, nextRange.end - cur);
        } else {
          setBuffered((prev) => Math.max(prev, cur));
        }
      }

      // Fase 3 (Regions): Atualiza o Playhead e a Janela Deslizante de 30s da MediaRegion
      sessionManager.updatePlayhead(cur, bufferAhead);
    };

    const onNativeTimeUpdate = () => {
      if (!videoEl) return;
      const vidCurTime = videoEl.currentTime || 0;
      const actualTotalTime = isSwitchingAudioRef.current
        ? vidCurTime + audioOffsetRef.current
        : vidCurTime;

      // Remux fMP4 (dublagem alternativa) não aceita Range: depois de um pause o navegador reabre a conexão,
      // o FFmpeg recomeça do `ss` original e o vídeo "volta" para o início do trecho. Se o tempo andar para
      // trás sem um seek explícito, refaz o remux a partir de onde a pessoa estava.
      if (
        isSwitchingAudioRef.current &&
        !isExplicitSeekingRef.current &&
        vidCurTime < 3 &&
        lastKnownTimeRef.current > 0 &&
        actualTotalTime < lastKnownTimeRef.current - 2
      ) {
        const resumeAt = lastKnownTimeRef.current;
        logger.warn(
          `[Áudio] O stream do áudio alternativo reiniciou em ${formatTime(actualTotalTime)}; voltando para ${formatTime(resumeAt)}`
        );
        handleSeekRef.current(resumeAt);
        return;
      }

      // Logo após um cold seek ainda chegam timeupdates do stream antigo com o offset novo; não confia neles
      if (!(isSwitchingAudioRef.current && isExplicitSeekingRef.current)) {
        lastKnownTimeRef.current = actualTotalTime;
      }
      setCurrentTime(actualTotalTime);
      updateBufferInfo();

      if (!videoEl.paused) {
        setPaused(false);
        setIsBuffering(false);
        if (resumePromptRef.current && actualTotalTime > 20) {
          setResumePrompt(null);
        }
      }

      // Salvar progresso a cada 5 segundos; perto do fim o episódio conta como assistido e não sugere retomar
      if (Math.floor(actualTotalTime) % 5 === 0 && actualTotalTime > 5) {
        try {
          const total = totalDurationRef.current;
          if (total > 0 && actualTotalTime > total * 0.95) localStorage.removeItem(getProgressStorageKey(source.src));
          else localStorage.setItem(getProgressStorageKey(source.src), actualTotalTime.toString());
        } catch {}
        // O que veio do catálogo também vira "continuar assistindo" (por título e episódio, sem o link)
        reportProgress(actualTotalTime, totalDurationRef.current);
      }

      // Checar transição de capítulo usando a ref mais recente (sem closure defasada nem spam)
      const activeChap = getCurrentChapter(actualTotalTime, normalizedChaptersRef.current);
      if (activeChap && activeChap.title && activeChap.title !== currentChapterRef.current?.title) {
        currentChapterRef.current = activeChap;
        logger.info(`[Player] Capítulo: ${activeChap.title}`);
      }
    };

    // Diagnóstico de lag: onde o buffer travou, quanto durou e o que o navegador estava fazendo
    let stall: { at: number; pos: number } | null = null;
    const describeStall = () => {
      if (!videoEl) return '';
      const offset = isSwitchingAudioRef.current ? audioOffsetRef.current : 0;
      const src = videoEl.currentSrc || '';
      const kind = src.startsWith('blob:') ? 'HLS' : src.includes('audio=') ? 'remux' : 'direto';
      const cur = videoEl.currentTime || 0;
      let ahead = 0;
      for (let i = 0; i < videoEl.buffered.length; i++) {
        if (cur >= videoEl.buffered.start(i) - 0.2 && cur <= videoEl.buffered.end(i) + 0.2) ahead = videoEl.buffered.end(i) - cur;
      }
      return `modo ${kind}, ${ahead.toFixed(1)} s à frente, readyState ${videoEl.readyState}, rede ${videoEl.networkState}`;
    };
    const endStall = () => {
      if (!stall) return;
      const secs = ((Date.now() - stall.at) / 1000).toFixed(1);
      logger.info(`[Player] Buffer resolvido após ${secs} s (travou em ${formatTime(stall.pos)})`);
      stall = null;
    };

    const onNativePlay = () => {
      setPaused(false);
      setIsBuffering(false);
    };
    const onNativePlaying = () => {
      endStall();
      setPaused(false);
      setIsBuffering(false);
    };
    const onNativePause = () => {
      if (!videoEl) return;
      if (videoEl.seeking || videoEl.readyState < 3) return;
      setPaused(true);
    };
    const onNativeWaiting = () => {
      if (!videoEl) return;
      // Só ativa indicador de buffer se a cabeça de reprodução realmente alcançou o fim dos dados baixados
      const b = videoEl.buffered;
      const cur = videoEl.currentTime || 0;
      let hasBufferedAhead = false;
      for (let i = 0; i < b.length; i++) {
        if (cur >= b.start(i) - 0.2 && cur < b.end(i) - 0.8) {
          hasBufferedAhead = true;
          break;
        }
      }
      if (!hasBufferedAhead) {
        setIsBuffering(true);
        if (!stall) {
          const pos = cur + (isSwitchingAudioRef.current ? audioOffsetRef.current : 0);
          stall = { at: Date.now(), pos };
          logger.warn(`[Player] Buffer esgotado em ${formatTime(pos)} (${describeStall()})`);
        }
      }
    };
    const onNativeSeeking = () => {
      if (videoEl) {
        const b = videoEl.buffered;
        const cur = videoEl.currentTime || 0;
        for (let i = 0; i < b.length; i++) {
          if (cur >= b.start(i) - 0.2 && cur <= b.end(i) + 0.2) {
            setIsBuffering(false);
            updateBufferInfo();
            return;
          }
        }
      }
      setIsBuffering(true);
      if (!stall) {
        const pos = (videoEl?.currentTime || 0) + (isSwitchingAudioRef.current ? audioOffsetRef.current : 0);
        stall = { at: Date.now(), pos };
        logger.warn(`[Player] Seek para ${formatTime(pos)} sem buffer carregado (${describeStall()})`);
      }
      updateBufferInfo();
    };
    const onNativeSeeked = () => {
      endStall();
      setIsBuffering(false);
      updateBufferInfo();
      if (wasPlayingBeforeSeekRef.current) {
        if (videoEl && videoEl.paused) {
          videoEl.play().catch(() => {});
        }
        setPaused(false);
      }
    };
    const onNativeCanPlay = () => {
      endStall();
      setIsBuffering(false);
      updateBufferInfo();
      if (wasPlayingBeforeSeekRef.current) {
        if (videoEl && videoEl.paused) {
          videoEl.play().catch(() => {});
        }
        setPaused(false);
      }
    };
    const onNativeProgress = () => {
      updateBufferInfo();
    };
    const updateResolution = () => {
      if (!videoEl || !setLiveResolution) return;
      const label = formatVideoHeight(videoEl.videoHeight);
      if (label) setLiveResolution(label);
    };


    const attachListeners = () => {
      if (!active) return;
      // Busca somente dentro do player para nunca prender listeners no <video> de prévia do ScreenShare
      videoEl = (playerRef.current?.el?.querySelector('video') as HTMLVideoElement | null) || null;

      if (!videoEl) {
        if (retryCount++ < 50) {
          retryTimer = setTimeout(attachListeners, 100);
        }
        return;
      }

      videoEl.addEventListener('timeupdate', onNativeTimeUpdate);
      videoEl.addEventListener('play', onNativePlay);
      videoEl.addEventListener('playing', onNativePlaying);
      videoEl.addEventListener('pause', onNativePause);
      videoEl.addEventListener('waiting', onNativeWaiting);
      videoEl.addEventListener('seeking', onNativeSeeking);
      videoEl.addEventListener('seeked', onNativeSeeked);
      videoEl.addEventListener('canplay', onNativeCanPlay);
      videoEl.addEventListener('progress', onNativeProgress);
      videoEl.addEventListener('loadedmetadata', updateResolution);
      videoEl.addEventListener('resize', updateResolution);
      updateBufferInfo();
      updateResolution();
    };

    attachListeners();

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (videoEl) {
        videoEl.removeEventListener('timeupdate', onNativeTimeUpdate);
        videoEl.removeEventListener('play', onNativePlay);
        videoEl.removeEventListener('playing', onNativePlaying);
        videoEl.removeEventListener('pause', onNativePause);
        videoEl.removeEventListener('waiting', onNativeWaiting);
        videoEl.removeEventListener('seeking', onNativeSeeking);
        videoEl.removeEventListener('seeked', onNativeSeeked);
        videoEl.removeEventListener('canplay', onNativeCanPlay);
        videoEl.removeEventListener('progress', onNativeProgress);
        videoEl.removeEventListener('loadedmetadata', updateResolution);
        videoEl.removeEventListener('resize', updateResolution);
      }
    };
  }, [resolvedStreamUrl]);
}
