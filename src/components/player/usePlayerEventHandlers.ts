import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import type { PlaybackReadiness } from '../../types/media';
import { formatTime } from '../../lib/chapters';
import { logger } from '../../lib/logger';
import { sessionManager } from '../../lib/session';
import { getVideoElement } from './dom';

/** Callbacks do `<MediaPlayer>` (Vidstack): pronto para tocar, tempo, play/pause, duração, buffer e erros de stream. */
export function usePlayerEventHandlers(args: {
  playerRef: RefObject<MediaPlayerInstance | null>;
  source: { src: string };
  autoPlay: boolean;
  paused: boolean;
  currentTime: number;
  resolvedStreamUrl: string;
  setResolvedStreamUrl: Dispatch<SetStateAction<string>>;
  isSwitchingAudioRef: MutableRefObject<boolean>;
  audioOffsetRef: MutableRefObject<number>;
  totalDurationRef: MutableRefObject<number>;
  wasPlayingBeforeAudioSwitchRef: MutableRefObject<boolean>;
  pendingPlayRef: MutableRefObject<boolean>;
  lastKnownTimeRef: MutableRefObject<number>;
  setPlaybackError: Dispatch<SetStateAction<any>>;
  setReadiness: Dispatch<SetStateAction<PlaybackReadiness>>;
  setDuration: Dispatch<SetStateAction<number>>;
  setPaused: Dispatch<SetStateAction<boolean>>;
  setCurrentTime: Dispatch<SetStateAction<number>>;
  setIsBuffering: Dispatch<SetStateAction<boolean>>;
  setBuffered: Dispatch<SetStateAction<number>>;
  setBufferedRanges: Dispatch<SetStateAction<{ start: number; end: number }[]>>;
  setControlsVisible: Dispatch<SetStateAction<boolean>>;
  /** HLS compartilhado de áudio alternativo (ver useAlternateAudio). */
  hlsModeRef: MutableRefObject<boolean>;
  pendingSeekRef: MutableRefObject<number | null>;
  fallbackToRemux: () => void;
}) {
  const {
    playerRef, source, autoPlay, paused, currentTime, resolvedStreamUrl, setResolvedStreamUrl,
    isSwitchingAudioRef, audioOffsetRef, totalDurationRef, wasPlayingBeforeAudioSwitchRef, pendingPlayRef, lastKnownTimeRef,
    setPlaybackError, setReadiness, setDuration, setPaused, setCurrentTime, setIsBuffering, setBuffered, setBufferedRanges, setControlsVisible,
    hlsModeRef, pendingSeekRef, fallbackToRemux,
  } = args;

  const onCanPlay = () => {
    setPlaybackError(null);
    logger.info('[Player] Pronto para tocar');
    setReadiness((prev) => ({ ...prev, video: true, audio: true }));

    // Troca de áudio por HLS: o stream novo abre do começo; volta ao ponto em que a pessoa estava e retoma se estava tocando
    if (pendingSeekRef.current !== null) {
      const target = pendingSeekRef.current;
      pendingSeekRef.current = null;
      const videoEl = getVideoElement(playerRef);
      if (videoEl) videoEl.currentTime = target;
      lastKnownTimeRef.current = target;
      setCurrentTime(target);
      if (wasPlayingBeforeAudioSwitchRef.current) {
        videoEl?.play().catch(() => {});
        setPaused(false);
      }
    }

    if (isSwitchingAudioRef.current) {
      // Em modo remux fMP4, o elemento de vídeo só conhece os fragmentos recebidos (ex: 9s ou 15s).
      // NUNCA permita que o fragmento fMP4 sobrescreva a duração total real do episódio!
      if (totalDurationRef.current > 0) {
        setDuration(totalDurationRef.current);
      }
      if (wasPlayingBeforeAudioSwitchRef.current) {
        const videoEl = getVideoElement(playerRef);
        if (videoEl) {
          videoEl.play().catch(() => {});
        } else if ((playerRef.current as any)?.state?.canPlay) {
          playerRef.current?.play().catch(() => {});
        }
        setPaused(false);
      }
      return;
    }

    const d = playerRef.current?.duration;
    if (d && isFinite(d) && d > 0) {
      if (totalDurationRef.current > 60 && d < 60) {
        setDuration(totalDurationRef.current);
      } else {
        totalDurationRef.current = d;
        setDuration(d);
      }
    } else if (totalDurationRef.current > 0) {
      setDuration(totalDurationRef.current);
    }

    // Se o usuário solicitou play antes do can-play estar pronto:
    if (pendingPlayRef.current || (!paused && autoPlay)) {
      pendingPlayRef.current = false;
      const videoEl = getVideoElement(playerRef);
      if (videoEl && videoEl.paused) {
        videoEl.play().catch(() => {});
        setPaused(false);
      }
    }
  };
  const onTimeUpdate = (detail: any) => {
    if (isSwitchingAudioRef.current) return;
    const t = typeof detail === 'number' ? detail : detail?.currentTime;
    if (t !== undefined && isFinite(t)) {
      lastKnownTimeRef.current = t;
      setCurrentTime(t);
    }
  };
  const onPlay = () => {
    setPaused(false);
    setIsBuffering(false);
    sessionManager.updateRunStatus('running');
    logger.action(`[Player] Play em ${formatTime(lastKnownTimeRef.current)}${isSwitchingAudioRef.current ? ' · áudio alternativo' : ''}`);
  };
  const onPause = () => {
    const videoEl = getVideoElement(playerRef);

    // Se o elemento nativo não está pausado (ex: stall temporário de stream), não marca como pausado
    if (videoEl && !videoEl.paused) {
      return;
    }

    setPaused(true);
    setControlsVisible(true);
    logger.action(`[Player] Pause em ${formatTime(lastKnownTimeRef.current)}${isSwitchingAudioRef.current ? ' · áudio alternativo' : ''}`);
  };
  const onDurationChange = (d) => {
    if (totalDurationRef.current > 0) {
      // Preserva a duração real do episódio detectada via FFmpeg ou metadados
      setDuration(totalDurationRef.current);
      return;
    }

    if (d && isFinite(d) && d > 0) {
      totalDurationRef.current = d;
      setDuration(d);
    }
  };
  const onProgress = (detail) => {
    if (detail.buffered && detail.buffered.length > 0) {
      const b = detail.buffered;
      const offset = isSwitchingAudioRef.current ? audioOffsetRef.current : 0;
      const ranges: { start: number; end: number }[] = [];
      for (let i = 0; i < b.length; i++) {
        ranges.push({
          start: Math.max(0, b.start(i) + offset),
          end: Math.max(0, b.end(i) + offset),
        });
      }
      setBufferedRanges(ranges);

      const cur = lastKnownTimeRef.current || currentTime;
      const active = ranges.find((r) => cur >= r.start - 2.0 && cur <= r.end + 1.5);
      if (active) {
        setBuffered(active.end);
      } else {
        const next = ranges.find((r) => r.end > cur);
        if (next) {
          setBuffered(next.end);
        } else {
          setBuffered(Math.max(0, b.end(b.length - 1) + offset));
        }
      }
    }
  };
  const onWaiting = () => {
    setIsBuffering(true);
  };
  const onError = (err: any) => {
    sessionManager.updateRunStatus('failed');
    if (hlsModeRef.current) {
      // HLS compartilhado falhou (segmento, rede, codec): continua pelo remux em vez de mostrar erro
      fallbackToRemux();
      return;
    }
    if (isSwitchingAudioRef.current) {
      // Ignora erro transitório durante a reconexão da dublagem
      return;
    }

    const errMsg = err?.message || err?.detail?.message || 'Failed to load resource.';
    const errCode = err?.code || err?.detail?.code || 4;

    let title = 'Erro ao Carregar Stream';
    let hint = 'O navegador não conseguiu abrir o arquivo de vídeo. Verifique se o link possui suporte a CORS e se o formato é aceito pelo navegador.';

    const srcLower = source.src.toLowerCase();
    if (srcLower.includes('torrentio.strem.fun') && !resolvedStreamUrl.includes('/api/proxy')) {
      title = 'Redirecionando Torrentio via Proxy...';
      hint = 'O stream está sendo roteado pelo backend local para streaming acelerado.';
      setResolvedStreamUrl(`/api/proxy?url=${encodeURIComponent(source.src)}#.mp4`);
      return;
    }

    setPlaybackError({
      title,
      message: errMsg,
      hint,
      code: errCode,
    });

    logger.error(`[Player] Erro de reprodução: ${errMsg} (código ${errCode})`, { url: source.src });
  };

  return { onCanPlay, onTimeUpdate, onPlay, onPause, onDurationChange, onProgress, onWaiting, onError };
}
