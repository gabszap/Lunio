import { useRef, useState, useMemo, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import type { AudioTrackOption, MediaSource } from '../../types/media';
import { useAccessReady, withAccess } from '../../lib/access';
import { formatTime } from '../../lib/chapters';
import { logger } from '../../lib/logger';
import { isHlsStreamUrl, startHlsAudio } from '../../lib/hls';
import { getYouTubeId } from '../../lib/media';
import { sessionManager } from '../../lib/session';
import { subtitleManager } from '../../lib/subtitles';
import { getVideoElement } from './dom';

/**
 * Áudio alternativo e URL do stream. Trocar de dublagem refaz o stream por remux fMP4 no servidor, a partir do ponto atual;
 * a escolha é individual (nada vai para a sala). Também decide a URL final que o <video> recebe (proxy, YouTube, upload).
 */
export function useAlternateAudio(args: {
  source: MediaSource;
  playerRef: RefObject<MediaPlayerInstance | null>;
  paused: boolean;
  currentTime: number;
  setIsBuffering: Dispatch<SetStateAction<boolean>>;
  setCurrentTime: Dispatch<SetStateAction<number>>;
  isSwitchingAudioRef: MutableRefObject<boolean>;
  audioOffsetRef: MutableRefObject<number>;
  wasPlayingBeforeAudioSwitchRef: MutableRefObject<boolean>;
  lastKnownTimeRef: MutableRefObject<number>;
  initialAudioTracks: AudioTrackOption[];
}) {
  const { source, playerRef, paused, currentTime, setIsBuffering, setCurrentTime, isSwitchingAudioRef, audioOffsetRef, wasPlayingBeforeAudioSwitchRef, lastKnownTimeRef, initialAudioTracks } = args;

  // HLS compartilhado: a linha do tempo é absoluta (sem `ss`/offset), então o seek é nativo e leva ~1 s
  const hlsModeRef = useRef(false);
  /** Depois de um erro do HLS neste vídeo, volta a usar só o remux contínuo. */
  const hlsDisabledRef = useRef(false);
  /** Posição a aplicar quando o novo stream estiver pronto (troca de áudio sem perder o ponto). */
  const pendingSeekRef = useRef<number | null>(null);
  const audioRequestRef = useRef(0);

  const [detectedAudioTracks, setDetectedAudioTracks] = useState<AudioTrackOption[]>(initialAudioTracks);
  const [activeAudioTrack, setActiveAudioTrack] = useState<AudioTrackOption | null>(null);

  // Stream URL gerenciada com suporte a streaming contínuo HTTP Range 206
  const [resolvedStreamUrl, setResolvedStreamUrl] = useState<string>(() => {
    const s = source.src || '';
    if (!s.trim()) return '';
    const ytId = getYouTubeId(s);
    if (ytId) return `youtube/${ytId}`;
    const isRemote = s.startsWith('http://') || s.startsWith('https://');
    if (isRemote && !s.startsWith('/api/proxy')) {
      return `/api/proxy?url=${encodeURIComponent(s)}#.mp4`;
    }
    return s;
  });

  // Fonte de mídia estável memorizada por URL para evitar recarregamento indevido no Vidstack
  const isRemuxStream = /[?&]audio=/.test(resolvedStreamUrl);

  // O token da sessão só precisa existir; trocar token solo por token de sala não recarrega o vídeo
  const accessReady = useAccessReady();
  const mediaSource = useMemo(() => {
    if (!resolvedStreamUrl) return undefined;
    // YouTube toca pelo provider próprio do Vidstack (iframe), sem proxy nem remux
    if (resolvedStreamUrl.startsWith('youtube/')) {
      return { src: resolvedStreamUrl, type: 'video/youtube' as const };
    }
    // O <video> não manda cabeçalhos: a API (/api/proxy, /api/uploads) recebe o token na URL
    // HLS compartilhado: hls.js (ou o HLS nativo do Safari) lê a playlist; os segmentos herdam o token da playlist
    if (isHlsStreamUrl(resolvedStreamUrl)) {
      return { src: withAccess(resolvedStreamUrl), type: 'application/x-mpegurl' as const };
    }
    return { src: withAccess(resolvedStreamUrl), type: 'video/mp4' as const };
  }, [resolvedStreamUrl, accessReady]);

  /** Com remux ativo, refaz o stream a partir de `targetTime` (o fMP4 do FFmpeg não aceita seek por Range). */
  const remuxFrom = (targetTime: number) => {
    const { generation } = sessionManager.evaluateSeek(targetTime, false);
    const activeTrackIdx =
      activeAudioTrack?.index !== undefined
        ? activeAudioTrack.index
        : (activeAudioTrack?.id || '');

    audioOffsetRef.current = targetTime;
    subtitleManager.setTimeOffset(targetTime);
    setIsBuffering(true);
    sessionManager.updateRunStatus('starting');

    const sessionId = sessionManager.getSessionId() || `session_${Date.now()}`;
    const audioParam = activeTrackIdx !== '' ? `&audio=${activeTrackIdx}` : '';
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(source.src)}${audioParam}&ss=${targetTime.toFixed(1)}&gen=${generation}&session=${sessionId}#.mp4`;
    setResolvedStreamUrl(proxyUrl);
    setCurrentTime(targetTime);
    logger.action(`[Player] Pulando para ${formatTime(targetTime)} (refazendo o stream de áudio)`);
  };

  // Handler de troca de áudio / dublagem via remux do FFmpeg (escolha individual do espectador)
  const handleAudioTrackChange = (track: AudioTrackOption | null) => {
    setActiveAudioTrack(track);
    if (!track) return;

    logger.action(`[Áudio] Trocando para: ${track.label}`);

    const videoEl = getVideoElement(playerRef);

    const isCurrentlyPlaying = videoEl ? !videoEl.paused : !paused;
    wasPlayingBeforeAudioSwitchRef.current = isCurrentlyPlaying;

    const curTime = currentTime || videoEl?.currentTime || playerRef.current?.currentTime || 0;

    const request = ++audioRequestRef.current;

    // Se o usuário selecionou a faixa de áudio padrão (#0 ou primeira faixa), volta para streaming nativo Range 206
    if (track.index === 0 || track.id === '0' || (detectedAudioTracks.length > 0 && track.id === detectedAudioTracks[0].id)) {
      if (hlsModeRef.current) {
        // veio do HLS: o novo stream começa do zero, então reaplica o ponto atual quando ficar pronto
        hlsModeRef.current = false;
        pendingSeekRef.current = lastKnownTimeRef.current || curTime;
      }
      isSwitchingAudioRef.current = false;
      audioOffsetRef.current = 0;
      subtitleManager.setTimeOffset(0);
      const proxyUrl = `/api/proxy?url=${encodeURIComponent(source.src)}#.mp4`;
      setResolvedStreamUrl(proxyUrl);
      if (videoEl) {
        videoEl.currentTime = curTime;
      }
      logger.info(`[Áudio] De volta à faixa original: ${track.label}`);
      return;
    }

    const trackIdx = track.index !== undefined ? track.index : track.id;

    // Remux contínuo (um FFmpeg por pessoa, recomeça a cada seek): plano B quando o HLS não se aplica
    const useRemux = (atTime: number) => {
      hlsModeRef.current = false;
      isSwitchingAudioRef.current = true;
      audioOffsetRef.current = atTime;
      subtitleManager.setTimeOffset(atTime);
      setIsBuffering(true);

      const { generation } = sessionManager.evaluateSeek(atTime, false);
      sessionManager.updateRunStatus('starting');

      const sessionId = sessionManager.getSessionId() || `session_${Date.now()}`;
      const proxyUrl = `/api/proxy?url=${encodeURIComponent(source.src)}&audio=${trackIdx}&ss=${atTime.toFixed(1)}&gen=${generation}&session=${sessionId}#.mp4`;
      setResolvedStreamUrl(proxyUrl);
      logger.info(`[Áudio] Gerando stream com "${track.label}" a partir de ${formatTime(atTime)}`);
    };

    const audioIndex = Number(trackIdx);
    if (hlsDisabledRef.current || !Number.isInteger(audioIndex)) {
      useRemux(curTime);
      return;
    }

    // HLS compartilhado: segmentos de ~6 s gerados uma vez no servidor para todos que escolhem este áudio
    setIsBuffering(true);
    const fingerprint = sessionManager.getSession()?.source.mediaFingerprint;
    void startHlsAudio(source.src, audioIndex, fingerprint).then((playlist) => {
      if (request !== audioRequestRef.current) return; // a pessoa já escolheu outra faixa
      const resumeAt = lastKnownTimeRef.current || curTime;
      if (!playlist) {
        useRemux(resumeAt);
        return;
      }
      isSwitchingAudioRef.current = false;
      audioOffsetRef.current = 0;
      subtitleManager.setTimeOffset(0);
      hlsModeRef.current = true;
      pendingSeekRef.current = resumeAt;
      sessionManager.updateRunStatus('starting');
      setResolvedStreamUrl(playlist);
      logger.info(`[Áudio] "${track.label}" via HLS compartilhado a partir de ${formatTime(resumeAt)}`);
    });
  };

  /** Erro do HLS no meio da reprodução: desliga o HLS para este vídeo e continua pelo remux, do ponto atual. */
  const fallbackToRemux = () => {
    const at = lastKnownTimeRef.current;
    hlsModeRef.current = false;
    hlsDisabledRef.current = true;
    pendingSeekRef.current = null;
    logger.warn('[Áudio] O HLS falhou; continuando pelo remux');
    isSwitchingAudioRef.current = true;
    audioOffsetRef.current = at;
    subtitleManager.setTimeOffset(at);
    setIsBuffering(true);
    remuxFrom(at);
  };

  return {
    detectedAudioTracks,
    setDetectedAudioTracks,
    activeAudioTrack,
    setActiveAudioTrack,
    resolvedStreamUrl,
    setResolvedStreamUrl,
    isRemuxStream,
    mediaSource,
    remuxFrom,
    handleAudioTrackChange,
    hlsModeRef,
    pendingSeekRef,
    fallbackToRemux,
  };
}
