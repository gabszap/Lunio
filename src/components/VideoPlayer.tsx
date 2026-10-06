import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  MediaPlayer,
  MediaProvider,
  Track,
  Captions,
  type MediaPlayerInstance,
} from '@vidstack/react';
import '@vidstack/react/player/styles/base.css';
import { TriangleAlert, RefreshCw, Play, RotateCcw, X, FastForward, Film, Users, MessageSquare, Pause, Crown, Plus, ChevronLeft } from 'lucide-react';

import { MediaSource, Chapter, SubtitleTrack, AudioTrackOption, PlaybackReadiness } from '../types/media';
import { PlayerControls } from './PlayerControls';
import { WatchPartyPanel } from './WatchPartyPanel';
import { Avatar, Dot, GhostButton, IconButton, Kbd, PrimaryButton, Spinner } from './ui';
import { logger } from '../lib/logger';
import { audioBoost } from '../lib/audioBoost';
import { normalizeChapters, getCurrentChapter, formatTime, getSkippableChapter } from '../lib/chapters';
import { subtitleManager, subtitleResolver } from '../lib/subtitles';
import { resolveMediaRef, getYouTubeId } from '../lib/media';
import { sessionManager } from '../lib/session';
import { syncManager } from '../lib/sync';

export type AspectMode = 'fit' | 'stretch' | 'fill';

interface VideoPlayerProps {
  source: MediaSource;
  title?: string;
  chapters?: Chapter[];
  subtitles?: SubtitleTrack[];
  audioTracks?: AudioTrackOption[];
  autoPlay?: boolean;
  onResetToWorkingPreset?: () => void;
  onMediaChangeRequested?: (media: any) => void;
  onOpenRoomLobby?: () => void;
  isWatchPartyOpen?: boolean;
  onToggleWatchParty?: () => void;
  onCloseWatchParty?: () => void;
  /** Volta para a Home (botão "Voltar" no topo do player). */
  onBack?: () => void;
  /** Abre o modal "Adicionar legenda". */
  onAddSubtitle?: () => void;
  /** Estado vazio: "Escolher um vídeo". */
  onChooseVideo?: () => void;
  /** Botão "Sair" do painel da Watch Party. */
  onLeaveRoom?: () => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  source,
  title,
  chapters: initialChapters = [],
  subtitles: initialSubtitles = [],
  audioTracks: initialAudioTracks = [],
  autoPlay = false,
  onResetToWorkingPreset,
  onMediaChangeRequested,
  onOpenRoomLobby,
  isWatchPartyOpen: propIsWatchPartyOpen,
  onToggleWatchParty,
  onCloseWatchParty,
  onBack,
  onAddSubtitle,
  onChooseVideo,
  onLeaveRoom,
}) => {
  const playerRef = useRef<MediaPlayerInstance>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isSwitchingAudioRef = useRef<boolean>(false);
  const audioOffsetRef = useRef<number>(0);
  const totalDurationRef = useRef<number>(0);
  const wasPlayingBeforeAudioSwitchRef = useRef<boolean>(true);
  const wasPlayingBeforeSeekRef = useRef<boolean>(false);
  const pendingPlayRef = useRef<boolean>(false);
  const lastKnownTimeRef = useRef<number>(0);
  const isExplicitSeekingRef = useRef<boolean>(false);
  const handleSeekRef = useRef<(time: number) => void>(() => {});
  const handleAudioTrackChangeRef = useRef<(track: AudioTrackOption | null) => void>(() => {});
  // Vídeo para o qual o Host já retomou a posição da sala (evita repetir a cada mudança de readiness)
  const hostResumedSrcRef = useRef<string>('');

  // Playback error diagnostics
  const [playbackError, setPlaybackError] = useState<{
    title: string;
    message: string;
    hint: string;
    code?: number;
  } | null>(null);

  // Tracks detectadas dinamicamente via FFmpeg
  const [detectedChapters, setDetectedChapters] = useState<Chapter[]>(initialChapters);
  const [detectedSubtitles, setDetectedSubtitles] = useState<SubtitleTrack[]>(initialSubtitles);
  const [detectedAudioTracks, setDetectedAudioTracks] = useState<AudioTrackOption[]>(initialAudioTracks);
  const [isInspecting, setIsInspecting] = useState<boolean>(false);

  // PlaybackReadiness (v8): Controle preciso de prontidão (vídeo + áudio + legenda obrigatória)
  const [readiness, setReadiness] = useState<PlaybackReadiness>({
    video: false,
    audio: false,
    selectedSubtitle: {
      enabled: false,
      required: false,
      ready: true,
    },
  });
  const [isPreparingSubtitle, setIsPreparingSubtitle] = useState<boolean>(false);

  // Player state
  const [paused, setPaused] = useState<boolean>(true);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [buffered, setBuffered] = useState<number>(0);
  const [bufferedRanges, setBufferedRanges] = useState<{ start: number; end: number }[]>([]);
  const [mediaTitle, setMediaTitle] = useState<string>(title || '');
  const [parsedMetadata, setParsedMetadata] = useState<any>(null);
  const [isBuffering, setIsBuffering] = useState<boolean>(false);
  const [aspectMode, setAspectMode] = useState<AspectMode>('fit');
  const [aspectToast, setAspectToast] = useState<string | null>(null);
  const [volume, setVolume] = useState<number>(() => {
    const saved = localStorage.getItem('vidstack_player_volume');
    return saved !== null ? Math.min(1, Math.max(0, parseFloat(saved))) : 0.75;
  });
  const [muted, setMuted] = useState<boolean>(() => {
    return localStorage.getItem('vidstack_player_muted') === 'true';
  });
  const [playbackRate, setPlaybackRate] = useState<number>(() => {
    const saved = localStorage.getItem('vidstack_player_rate');
    return saved !== null ? parseFloat(saved) : 1.0;
  });
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

  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isPip, setIsPip] = useState<boolean>(false);
  const [canPip, setCanPip] = useState<boolean>(false);

  // Selected tracks
  const [activeSubtitle, setActiveSubtitle] = useState<SubtitleTrack | null>(null);
  const [activeAudioTrack, setActiveAudioTrack] = useState<AudioTrackOption | null>(null);

  // Prompt flutuante para erro/fallback de legenda obrigatória (Gating v8)
  const [subtitleFailurePrompt, setSubtitleFailurePrompt] = useState<{
    track: SubtitleTrack;
    error: string;
    code?: string;
  } | null>(null);
  const failedSubtitleSrcsRef = useRef<Set<string>>(new Set());

  // Prompt flutuante para retomar reprodução do momento anterior
  const [resumePrompt, setResumePrompt] = useState<{ time: number; formatted: string } | null>(null);

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
      const videoEl =
        playerRef.current?.el?.querySelector('video') ||
        (document.querySelector('video') as HTMLVideoElement | null);
      const vidCur = videoEl?.currentTime || lastKnownTimeRef.current || 0;
      return isSwitchingAudioRef.current ? vidCur + audioOffsetRef.current : vidCur;
    });

    const unsubState = syncManager.subscribeState(() => {
      setSyncStatus(syncManager.getStatus());
    });

    const unsubPlayback = syncManager.subscribePlayback(
      (action, position, rate, triggeredBy, username) => {
        const videoEl =
          playerRef.current?.el?.querySelector('video') ||
          (document.querySelector('video') as HTMLVideoElement | null);

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

    // Faixas de áudio e legendas são individuais para cada membro da sala
    const unsubTracks = syncManager.subscribeTracks(() => {
      // Intencionalmente mantido local: cada membro pode escolher seu áudio (japonês, português) e legendas de forma independente
    });

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
      unsubTracks();
      unsubMedia();
      unsubChat();
      unsubError();
    };
  }, [detectedAudioTracks, detectedSubtitles, currentTime, onMediaChangeRequested]);

  // Host: Emissão contínua da timeline real para sincronizar autoritativamente os espectadores (evita que o espectador se antecipe)
  useEffect(() => {
    if (paused || !syncStatus.isConnected || !syncStatus.isHost) return;
    const interval = setInterval(() => {
      const videoEl =
        playerRef.current?.el?.querySelector('video') ||
        (document.querySelector('video') as HTMLVideoElement | null);
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
      const videoEl =
        playerRef.current?.el?.querySelector('video') ||
        (document.querySelector('video') as HTMLVideoElement | null);
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
      readiness.selectedSubtitle.ready;
    const isReady = readiness.video && readiness.audio && isSubReady;
    syncManager.emitReadiness(
      isReady,
      isBuffering ? 'loading' : paused ? 'paused' : 'playing',
      lastKnownTimeRef.current || 0
    );
  }, [readiness, isBuffering, paused]);

  const hasSource = Boolean(source.src && source.src.trim());

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

  const mediaSource = React.useMemo(() => {
    if (!resolvedStreamUrl) return undefined;
    // YouTube toca pelo provider próprio do Vidstack (iframe), sem proxy nem remux
    if (resolvedStreamUrl.startsWith('youtube/')) {
      return { src: resolvedStreamUrl, type: 'video/youtube' as const };
    }
    return { src: resolvedStreamUrl, type: 'video/mp4' as const };
  }, [resolvedStreamUrl]);

  useEffect(() => {
    if (title) setMediaTitle(title);
  }, [title]);

  // Salvar e restaurar progresso do vídeo (Resume playback)
  const getProgressStorageKey = (url: string) => `streamplayer_progress_${encodeURIComponent(url.slice(0, 100))}`;

  // Inspeção automática de faixas via FFmpeg ao mudar a fonte
  useEffect(() => {
    let isCancelled = false;
    setPlaybackError(null);
    setSubtitleFailurePrompt(null);
    failedSubtitleSrcsRef.current.clear();
    currentChapterRef.current = null;
    pendingPlayRef.current = false;

    if (!hasSource) {
      setResolvedStreamUrl('');
      setIsInspecting(false);
      sessionManager.closeSession();
      return;
    }

    // Checa se há progresso salvo para sugerir retomada em popup (o vídeo sempre inicia do 0)
    try {
      const savedTime = parseFloat(localStorage.getItem(getProgressStorageKey(source.src)) || '0');
      if (savedTime > 10) {
        setResumePrompt({ time: savedTime, formatted: formatTime(savedTime) });
      } else {
        setResumePrompt(null);
      }
    } catch {
      setResumePrompt(null);
    }

    const ytId = getYouTubeId(source.src);
    if (ytId) {
      setResolvedStreamUrl(`youtube/${ytId}`);
      setIsInspecting(false);
      setDetectedChapters(initialChapters);
      setDetectedSubtitles(initialSubtitles);
      setDetectedAudioTracks([]);
      setActiveAudioTrack(null);
      logger.info(`[Mídia] Vídeo do YouTube: ${ytId}`);
      return () => {
        isCancelled = true;
      };
    }

    const isRemoteStream = source.src.startsWith('http://') || source.src.startsWith('https://');

    // Roteia via proxy nativo para bypass de CORS, SSL e redirecionamento de links debrid
    if (isRemoteStream && !source.src.startsWith('/api/proxy')) {
      const proxyUrl = `/api/proxy?url=${encodeURIComponent(source.src)}#.mp4`;
      setResolvedStreamUrl(proxyUrl);
    } else {
      setResolvedStreamUrl(source.src);
    }

    if (isRemoteStream) {
      setIsInspecting(true);
      logger.info('[Mídia] Lendo faixas de áudio, legendas e capítulos…');

      resolveMediaRef(source.src, initialSubtitles)
        .then(async (resolvedMedia) => {
          if (isCancelled || !resolvedMedia) return;

          // Fase 2: Registra a sessão de mídia formal com generation tracking
          sessionManager.createSession(resolvedMedia, 0);

          if (resolvedMedia.title) {
            setMediaTitle(resolvedMedia.title);
            logger.info(`[Mídia] Título: ${resolvedMedia.title}`);
          }
          if (resolvedMedia.parsedTorrent) {
            setParsedMetadata(resolvedMedia.parsedTorrent);
          }
          if (resolvedMedia.duration && resolvedMedia.duration > 0) {
            totalDurationRef.current = resolvedMedia.duration;
            setDuration(resolvedMedia.duration);
            logger.info(`[Mídia] Duração: ${formatTime(resolvedMedia.duration)}`);
          }

          const audios: AudioTrackOption[] = (resolvedMedia.audioTracks || []).map((a) => ({
            id: a.id,
            index: a.index,
            label: a.label,
            language: a.language,
            codec: a.codec,
            isDefault: a.isDefault,
          }));

          const chaps: Chapter[] = (resolvedMedia.chapters || []).map((c) => ({
            startTime: c.startTime,
            endTime: c.endTime,
            title: c.title,
          }));

          // Se duration não estiver presente, infere duração pelo término do último capítulo
          if (chaps.length > 0) {
            const maxChapEnd = Math.max(0, ...chaps.map((c) => c.endTime || c.startTime || 0));
            if (maxChapEnd > totalDurationRef.current) {
              totalDurationRef.current = maxChapEnd;
              setDuration(maxChapEnd);
              logger.info(`[Mídia] Duração estimada pelos capítulos: ${formatTime(maxChapEnd)}`);
            }
          }

          if (audios.length > 0) {
            setDetectedAudioTracks(audios);
            setActiveAudioTrack(audios[0]);
            logger.info(`[Mídia] ${audios.length} ${audios.length === 1 ? 'faixa' : 'faixas'} de áudio`);
          } else {
            setDetectedAudioTracks(initialAudioTracks);
          }

          if (chaps.length > 0) {
            setDetectedChapters(chaps);
            logger.info(`[Mídia] ${chaps.length} ${chaps.length === 1 ? 'capítulo' : 'capítulos'}`);
          } else {
            setDetectedChapters(initialChapters);
          }

          // Resolução desacoplada de legendas via SubtitleResolver (descoberta paralela + ranking determinístico v8)
          const { candidates, topCandidate } = await subtitleResolver.resolveCandidates(resolvedMedia, {
            preferredLanguages: ['pt-br', 'por', 'pt', 'en'],
            preferAssForAnime: true,
            requireSubtitle: true,
          });

          if (isCancelled) return;

          if (candidates.length > 0) {
            // Preserva a ordem original das faixas do container (stream index) na lista do menu
            const subs: SubtitleTrack[] = candidates.map((c) => subtitleResolver.candidateToTrack(c));
            setDetectedSubtitles(subs);

            const topTrack = topCandidate
              ? (subs.find((s) => s.id === topCandidate.id) || subs[0])
              : subs[0];

            // Avalia se legenda é estritamente obrigatória antes de iniciar reprodução
            const isJapanese = audios.some((a) => a.language?.includes('jpn') || a.label.toLowerCase().includes('japon'));
            const isPortugueseAudio = audios.some((a) => a.language?.includes('por') || a.label.toLowerCase().includes('portug'));
            const isRequired = isJapanese || !isPortugueseAudio;

            setReadiness((prev) => ({
              ...prev,
              selectedSubtitle: {
                enabled: true,
                required: isRequired,
                ready: false,
                candidateId: topTrack.id,
              },
            }));

            setActiveSubtitle(topTrack);
            logger.info(`[Legenda] Escolhida automaticamente: ${topTrack.label}`);
          } else {
            setDetectedSubtitles(initialSubtitles);
            setReadiness((prev) => ({
              ...prev,
              selectedSubtitle: {
                enabled: false,
                required: false,
                ready: true,
              },
            }));
          }
        })
        .catch((err) => {
          logger.warn('[Mídia] Não deu pra ler todas as faixas:', err);
        })
        .finally(() => {
          if (!isCancelled) setIsInspecting(false);
        });
    } else {
      setDetectedAudioTracks(initialAudioTracks);
      setDetectedSubtitles(initialSubtitles);
      setDetectedChapters(initialChapters);
      const defaultTrack = initialSubtitles.find((s) => s.default) || initialSubtitles[0] || null;
      setActiveSubtitle(defaultTrack);
      setActiveAudioTrack(initialAudioTracks[0] || null);
      setReadiness((prev) => ({
        ...prev,
        selectedSubtitle: {
          enabled: !!defaultTrack,
          required: false,
          ready: true,
        },
      }));
    }

    return () => {
      isCancelled = true;
    };
  }, [source.src]);

  // Normalized chapters
  const normalizedChapters = normalizeChapters(detectedChapters, duration);
  const normalizedChaptersRef = useRef<Chapter[]>(normalizedChapters);
  normalizedChaptersRef.current = normalizedChapters;
  const currentChapterRef = useRef<Chapter | null>(null);

  // Detecção de capítulo pulável (Abertura / Encerramento / Recap) estilo Netflix / Crunchyroll
  const skippableChapter = React.useMemo(() => {
    return getSkippableChapter(currentTime, normalizedChapters);
  }, [currentTime, normalizedChapters]);

  // Controls visibility management
  const [controlsVisible, setControlsVisible] = useState<boolean>(true);
  const hideControlsTimeout = useRef<number | null>(null);
  // Com um menu (legendas, áudio, ajustes…) aberto os controles não somem
  const menuOpenRef = useRef<boolean>(false);

  const resetControlsTimer = useCallback(() => {
    setControlsVisible((prev) => (prev ? prev : true));
    if (hideControlsTimeout.current) {
      window.clearTimeout(hideControlsTimeout.current);
    }
    if (!paused && !menuOpenRef.current) {
      hideControlsTimeout.current = window.setTimeout(() => {
        setControlsVisible(false);
      }, 3000);
    }
  }, [paused]);

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      menuOpenRef.current = open;
      resetControlsTimer();
    },
    [resetControlsTimer]
  );

  // Web Audio Boost attachment to native video element
  useEffect(() => {
    const timer = setTimeout(() => {
      if (playerRef.current?.el) {
        const videoEl = playerRef.current.el.querySelector('video');
        if (videoEl) {
          audioBoost.attachToElement(videoEl);
          if (document.pictureInPictureEnabled && typeof videoEl.requestPictureInPicture === 'function') {
            setCanPip(true);
          }
        }
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [source.src, resolvedStreamUrl]);

  // Handle active subtitle changes com SubtitleManager (JASSUB WASM + Nativo) e PlaybackReadiness
  useEffect(() => {
    let isCancelled = false;
    const abortController = new AbortController();

    if (activeSubtitle) {
      logger.info(`[Legenda] Ativada: ${activeSubtitle.label}`);
      localStorage.setItem('vidstack_player_subtitle', activeSubtitle.src);

      const videoEl =
        playerRef.current?.el?.querySelector('video') ||
        (document.querySelector('video') as HTMLVideoElement | null);

      if (videoEl) {
        setIsPreparingSubtitle(true);
        subtitleManager
          .applyTrack(videoEl, activeSubtitle, audioOffsetRef.current, abortController.signal)
          .then(() => {
            if (isCancelled) return;
            setIsPreparingSubtitle(false);
            setSubtitleFailurePrompt(null);
            setReadiness((prev) => ({
              ...prev,
              selectedSubtitle: { ...prev.selectedSubtitle, ready: true, failed: false },
            }));
          })
          .catch((err) => {
            if (isCancelled || err.name === 'AbortError') return;
            setIsPreparingSubtitle(false);
            logger.error(`[Legenda] Falha ao preparar "${activeSubtitle.label}":`, err);

            // Requisito 3: Gating de legenda obrigatória e propagação de erros
            const isRequired = readiness.selectedSubtitle.required;
            if (isRequired) {
              // Legenda obrigatória: NÃO marcar ready: true; bloquear playback e exibir banner de UX
              setReadiness((prev) => ({
                ...prev,
                selectedSubtitle: { ...prev.selectedSubtitle, ready: false, failed: true },
              }));
              let friendlyMessage = err.message || 'Falha ao renderizar a faixa de legenda.';
              if (err.code === 'BITMAP_NOT_SUPPORTED') {
                friendlyMessage = 'Formato de legenda baseado em imagem (PGS/VobSub) não é suportado pelo renderizador.';
              } else if (err.code === 'EXTRACTION_FAILED') {
                friendlyMessage = 'Não foi possível extrair a legenda embutida do arquivo.';
              }
              setSubtitleFailurePrompt({
                track: activeSubtitle,
                error: friendlyMessage,
                code: err.code,
              });
            } else {
              // Legenda opcional: não bloqueia a reprodução global
              setReadiness((prev) => ({
                ...prev,
                selectedSubtitle: { ...prev.selectedSubtitle, ready: true, failed: true },
              }));
            }
          });
      }
    } else {
      logger.info('[Legenda] Desativada');
      localStorage.removeItem('vidstack_player_subtitle');
      subtitleManager.applyTrack(null as any, null);
      setIsPreparingSubtitle(false);
      setSubtitleFailurePrompt(null);
      setReadiness((prev) => ({
        ...prev,
        selectedSubtitle: { ...prev.selectedSubtitle, enabled: false, ready: true, failed: false },
      }));
    }

    return () => {
      isCancelled = true;
      abortController.abort();
    };
  }, [activeSubtitle]);

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
        const videoEl =
          playerRef.current?.el?.querySelector('video') ||
          (document.querySelector('video') as HTMLVideoElement | null);
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
      const videoEl =
        playerRef.current?.el?.querySelector('video') ||
        (document.querySelector('video') as HTMLVideoElement | null);
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

    if (!autoPlay && !pendingPlayRef.current) return;

    if (paused) {
      logger.info('[Player] Vídeo, áudio e legenda prontos; iniciando');
      const videoEl =
        playerRef.current?.el?.querySelector('video') ||
        (document.querySelector('video') as HTMLVideoElement | null);

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

  // Sincronização direta e contínua do elemento <video> nativo (imune a dessincronias do Vidstack)
  useEffect(() => {
    let active = true;
    let videoEl: HTMLVideoElement | null = null;
    let retryTimer: any = null;

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
        if (resumePrompt && actualTotalTime > 20) {
          setResumePrompt(null);
        }
      }

      // Salvar progresso a cada 5 segundos
      if (Math.floor(actualTotalTime) % 5 === 0 && actualTotalTime > 5) {
        try {
          localStorage.setItem(getProgressStorageKey(source.src), actualTotalTime.toString());
        } catch {}
      }

      // Checar transição de capítulo usando a ref mais recente (sem closure defasada nem spam)
      const activeChap = getCurrentChapter(actualTotalTime, normalizedChaptersRef.current);
      if (activeChap && activeChap.title && activeChap.title !== currentChapterRef.current?.title) {
        currentChapterRef.current = activeChap;
        logger.info(`[Player] Capítulo: ${activeChap.title}`);
      }
    };

    const onNativePlay = () => {
      setPaused(false);
      setIsBuffering(false);
    };
    const onNativePlaying = () => {
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
        logger.warn('[Player] Carregando buffer…');
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
      updateBufferInfo();
    };
    const onNativeSeeked = () => {
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


    const attachListeners = () => {
      if (!active) return;
      videoEl =
        playerRef.current?.el?.querySelector('video') ||
        (document.querySelector('video') as HTMLVideoElement | null);

      if (!videoEl) {
        retryTimer = setTimeout(attachListeners, 100);
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
      updateBufferInfo();
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
      }
    };
  }, [resolvedStreamUrl]);

  // Handler de troca de áudio / dublagem via remux do FFmpeg (escolha individual do espectador)
  const handleAudioTrackChange = (track: AudioTrackOption | null) => {
    setActiveAudioTrack(track);
    if (!track) return;

    logger.action(`[Áudio] Trocando para: ${track.label}`);

    const videoEl =
      playerRef.current?.el?.querySelector('video') ||
      (document.querySelector('video') as HTMLVideoElement | null);

    const isCurrentlyPlaying = videoEl ? !videoEl.paused : !paused;
    wasPlayingBeforeAudioSwitchRef.current = isCurrentlyPlaying;

    const curTime = currentTime || videoEl?.currentTime || playerRef.current?.currentTime || 0;

    // Se o usuário selecionou a faixa de áudio padrão (#0 ou primeira faixa), volta para streaming nativo Range 206
    if (track.index === 0 || track.id === '0' || (detectedAudioTracks.length > 0 && track.id === detectedAudioTracks[0].id)) {
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

    // Sincroniza dublagem via FFmpeg com offset temporal perfeito
    isSwitchingAudioRef.current = true;
    audioOffsetRef.current = curTime;
    subtitleManager.setTimeOffset(curTime);
    setIsBuffering(true);

    const { generation } = sessionManager.evaluateSeek(curTime, false);
    sessionManager.updateRunStatus('starting');

    const sessionId = sessionManager.getSessionId() || `session_${Date.now()}`;
    const trackIdx = track.index !== undefined ? track.index : track.id;
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(source.src)}&audio=${trackIdx}&ss=${curTime.toFixed(1)}&gen=${generation}&session=${sessionId}#.mp4`;
    setResolvedStreamUrl(proxyUrl);
    logger.info(`[Áudio] Gerando stream com "${track.label}" a partir de ${formatTime(curTime)}`);
  };

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
    const videoEl =
      playerRef.current?.el?.querySelector('video') ||
      (document.querySelector('video') as HTMLVideoElement | null);
    if (videoEl && videoEl.paused) {
      videoEl.play().catch(() => {});
    }
  };

  // Ação de tentar próxima legenda disponível ao falhar a legenda obrigatória
  const handleTryNextSubtitle = () => {
    if (!activeSubtitle) return;
    failedSubtitleSrcsRef.current.add(activeSubtitle.src);
    const remaining = detectedSubtitles.filter((s) => !failedSubtitleSrcsRef.current.has(s.src));
    if (remaining.length > 0) {
      const nextTrack = remaining[0];
      setSubtitleFailurePrompt(null);
      setReadiness((prev) => ({
        ...prev,
        selectedSubtitle: {
          ...prev.selectedSubtitle,
          enabled: true,
          required: true,
          ready: false,
          failed: false,
        },
      }));
      setActiveSubtitle(nextTrack);
      logger.action(`[Legenda] Tentando a próxima: ${nextTrack.label}`);
    } else {
      setSubtitleFailurePrompt((prev) =>
        prev
          ? {
              ...prev,
              error: 'Nenhuma outra legenda disponível para este vídeo.',
            }
          : null
      );
    }
  };

  // Ação explícita do usuário de ignorar a legenda obrigatória e assistir sem legenda
  const handleWatchWithoutSubtitle = () => {
    setSubtitleFailurePrompt(null);
    setActiveSubtitle(null);
    setReadiness((prev) => ({
      ...prev,
      selectedSubtitle: {
        enabled: false,
        required: false,
        ready: true,
        failed: false,
      },
    }));
    logger.action('[Legenda] Assistindo sem legenda');

    const videoEl =
      playerRef.current?.el?.querySelector('video') ||
      (document.querySelector('video') as HTMLVideoElement | null);
    if (videoEl && videoEl.paused) {
      videoEl.play().catch(() => {});
      setPaused(false);
    }
  };

  // Control handlers
  const handlePlayToggle = () => {
    if (syncStatus.isConnected && !syncStatus.isHost) {
      setSyncToast('A reprodução é controlada pelo Host da sala');
      setTimeout(() => setSyncToast(null), 2500);
      return;
    }

    const videoEl =
      playerRef.current?.el?.querySelector('video') ||
      (document.querySelector('video') as HTMLVideoElement | null);

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

    const videoEl =
      playerRef.current?.el?.querySelector('video') ||
      (document.querySelector('video') as HTMLVideoElement | null);

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

    const currentOffset = isSwitchingAudioRef.current ? audioOffsetRef.current : 0;
    // 1. Dublagem alternativa ativa com FFmpeg remux: Remuxa segmento físico a partir de targetTime
    // (Streams fMP4 chunked sem suporte a range não suportam seek confiável no elemento <video>; o FFmpeg garante precisão absoluta)
    if (isSwitchingAudioRef.current) {
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
    const { isColdSeek, generation } = sessionManager.evaluateSeek(targetTime, isInsideBuffer);

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
  handleAudioTrackChangeRef.current = handleAudioTrackChange;

  const handleVolumeBoostChange = (newBoost: number) => {
    setVolumeBoost(newBoost);
    audioBoost.setBoost(newBoost);
  };

  const triggerFullscreenVisuals = (active: boolean) => {
    setIsFullscreen(active);
    logger.action(active ? '[Player] Tela cheia' : '[Player] Saiu da tela cheia');

    if (active) {
      document.documentElement.classList.add('is-fullscreen');
      document.body.classList.add('is-fullscreen');
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
    } else {
      document.documentElement.classList.remove('is-fullscreen');
      document.body.classList.remove('is-fullscreen');
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    }

    // Avisa o Vidstack sobre a mudança de fullscreen para que o CSS interno (media-outlet) se ajuste
    if (playerRef.current?.el) {
      if (active) {
        playerRef.current.el.setAttribute('data-fullscreen', '');
      } else {
        playerRef.current.el.removeAttribute('data-fullscreen');
      }
    }

    // Dispara evento de redimensionamento para sincronizar layout e canvas
    window.dispatchEvent(new Event('resize'));

    // Re-alinha canvas do LibASS para prevenir qualquer sobreposição escura em tela cheia
    setTimeout(() => {
      subtitleManager.resize();
    }, 50);
    setTimeout(() => {
      subtitleManager.resize();
    }, 150);
    setTimeout(() => {
      subtitleManager.resize();
    }, 350);
  };

  const handleFullscreenToggle = () => {
    if (!containerRef.current) return;

    // Se já estiver em fullscreen (seja nativo ou modo janela / iframe)
    if (isFullscreen) {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch((err) => {
          logger.warn('[Player] Falha ao sair da tela cheia:', err);
          triggerFullscreenVisuals(false);
        });
      } else {
        triggerFullscreenVisuals(false);
      }
      return;
    }

    // Se não estiver em fullscreen, tenta nativo com fallback transparente para iframe do Discord
    if (typeof containerRef.current.requestFullscreen === 'function') {
      containerRef.current.requestFullscreen().catch(() => {
        logger.info('[Player] O Discord não permite tela cheia nativa; ocupando a janela inteira');
        triggerFullscreenVisuals(true);
      });
    } else {
      triggerFullscreenVisuals(true);
    }
  };

  const handlePipToggle = async () => {
    const videoEl = playerRef.current?.el?.querySelector('video');
    if (!videoEl) return;

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPip(false);
        logger.action('[Player] Picture-in-Picture desligado');
      } else if (typeof videoEl.requestPictureInPicture === 'function') {
        await videoEl.requestPictureInPicture();
        setIsPip(true);
        logger.action('[Player] Picture-in-Picture ligado');
      }
    } catch (err) {
      logger.warn('[Player] Erro no Picture-in-Picture:', err);
    }
  };

  // Fullscreen change listener
  useEffect(() => {
    const handleFsChange = () => {
      const isFs = !!document.fullscreenElement;
      triggerFullscreenVisuals(isFs);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.documentElement.classList.remove('is-fullscreen');
      document.body.classList.remove('is-fullscreen');
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    };
  }, []);

  // ResizeObserver e window resize listener para recalcular dimensões do canvas de legendas (JASSUB) no Split Screen
  useEffect(() => {
    const handleResize = () => {
      subtitleManager.resize();
    };
    window.addEventListener('resize', handleResize);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      resizeObserver = new ResizeObserver(() => {
        subtitleManager.resize();
      });
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    };
  }, []);

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
            setSyncToast('A reprodução é controlada pelo Host da sala');
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

  if (!hasSource) {
    const canChoose = Boolean(onChooseVideo) && (!syncStatus.isConnected || syncStatus.isHost);
    return (
      <div
        id="video-player-standby"
        className="relative w-full aspect-video min-h-[320px] rounded-[18px] lu-video-bg border border-lu-border overflow-hidden flex items-center justify-center select-none"
      >
        <div className="flex flex-col items-center text-center gap-5 px-6">
          <div className="w-16 h-16 rounded-[14px] bg-lu-tint border border-lu-accent/30 flex items-center justify-center text-lu-accent">
            <Film size={28} />
          </div>
          <div>
            <h2 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">Nenhum vídeo na sala</h2>
            <p className="mt-2 mx-auto mb-0 max-w-[420px] text-[14px] text-lu-muted">
              {canChoose || !syncStatus.isConnected
                ? 'Escolha um vídeo pra começar. Arquivo, YouTube, Drive ou link de stream.'
                : 'O Host ainda não escolheu o vídeo. Ele aparece aqui assim que for carregado.'}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3">
            {canChoose && (
              <PrimaryButton onClick={onChooseVideo}>
                <Plus size={18} />
                <span>Escolher um vídeo</span>
              </PrimaryButton>
            )}
            <GhostButton onClick={handleToggleWatchParty}>
              <Users size={18} />
              <span>Watch Party · {Math.max(1, syncStatus.membersCount)} online</span>
            </GhostButton>
          </div>
        </div>

        <WatchPartyPanel isOpen={isWatchPartyOpen} onClose={handleCloseWatchParty} onOpenRoomLobby={onOpenRoomLobby} onLeaveRoom={onLeaveRoom} />
      </div>
    );
  }

  const isCursorHidden = !controlsVisible && !paused;
  const showControls = controlsVisible || paused;

  const isNativeFs = typeof document !== 'undefined' && !!document.fullscreenElement;
  const isWindowFs = isFullscreen && !isNativeFs;
  const isViewer = syncStatus.isConnected && !syncStatus.isHost;
  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  const skipStart = skippableChapter ? getCurrentChapter(currentTime, normalizedChapters)?.startTime ?? 0 : 0;
  const skipProgress =
    skippableChapter && skippableChapter.targetTime > skipStart
      ? Math.min(100, Math.max(0, ((currentTime - skipStart) / (skippableChapter.targetTime - skipStart)) * 100))
      : 0;

  const bufferAheadNow = (() => {
    if (bufferedRanges.length > 0) {
      const activeR = bufferedRanges.find((r) => currentTime >= r.start - 0.5 && currentTime <= r.end + 0.5);
      if (activeR) return Math.max(0, activeR.end - currentTime);
      const upcoming = bufferedRanges.find((r) => r.start >= currentTime - 1 && r.start <= currentTime + 10);
      return upcoming ? Math.max(0, upcoming.end - currentTime) : 0;
    }
    return Math.max(0, buffered - currentTime);
  })();

  const pausedByName =
    hostPausedInfo?.username || syncManager.getRoomState()?.members.find((m) => m.isHost)?.username || 'Host';

  const floatingCard =
    'bg-lu-surface/90 backdrop-blur-md border border-lu-border shadow-[0_16px_40px_rgba(0,0,0,0.45)]';

  return (
    <div
      id="video-player-root"
      ref={containerRef}
      onMouseMove={resetControlsTimer}
      onPointerDown={resetControlsTimer}
      style={isCursorHidden ? { cursor: 'none' } : undefined}
      className={`${
        isWindowFs
          ? `fixed inset-0 z-50 w-screen h-screen max-w-none max-h-none window-fullscreen bg-black aspect-${aspectMode}`
          : isFullscreen
          ? `h-full aspect-auto rounded-none bg-black aspect-${aspectMode}`
          : `relative w-full aspect-video lu-video-bg aspect-${aspectMode}`
      } overflow-hidden select-none group text-lu-text ${isCursorHidden ? 'hide-cursor cursor-none' : ''}`}
    >
      {/* Vidstack Media Player Core */}
      <MediaPlayer
        ref={playerRef}
        src={mediaSource}
        // Remux fMP4 não aceita seek (seekable = 0–0): sem a duração real o Vidstack calcula duration = 0 e,
        // a cada play depois de um pause, "reinicia" o trecho do começo. Informar a duração evita isso.
        duration={isRemuxStream && duration > 0 ? duration : undefined}
        autoPlay={autoPlay && (!readiness.selectedSubtitle.required || (readiness.selectedSubtitle.ready && !readiness.selectedSubtitle.failed))}
        playsInline
        logLevel="warn"
        playbackRate={playbackRate}
        volume={volume}
        muted={muted}
        onCanPlay={() => {
          setPlaybackError(null);
          logger.info('[Player] Pronto para tocar');
          setReadiness((prev) => ({ ...prev, video: true, audio: true }));

          if (isSwitchingAudioRef.current) {
            // Em modo remux fMP4, o elemento de vídeo só conhece os fragmentos recebidos (ex: 9s ou 15s).
            // NUNCA permita que o fragmento fMP4 sobrescreva a duração total real do episódio!
            if (totalDurationRef.current > 0) {
              setDuration(totalDurationRef.current);
            }
            if (wasPlayingBeforeAudioSwitchRef.current) {
              const videoEl =
                playerRef.current?.el?.querySelector('video') ||
                (document.querySelector('video') as HTMLVideoElement | null);
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
            const videoEl =
              playerRef.current?.el?.querySelector('video') ||
              (document.querySelector('video') as HTMLVideoElement | null);
            if (videoEl && videoEl.paused) {
              videoEl.play().catch(() => {});
              setPaused(false);
            }
          }
        }}
        onTimeUpdate={(detail: any) => {
          if (isSwitchingAudioRef.current) return;
          const t = typeof detail === 'number' ? detail : detail?.currentTime;
          if (t !== undefined && isFinite(t)) {
            lastKnownTimeRef.current = t;
            setCurrentTime(t);
          }
        }}
        onPlay={() => {
          setPaused(false);
          setIsBuffering(false);
          sessionManager.updateRunStatus('running');
          logger.action(`[Player] Play em ${formatTime(lastKnownTimeRef.current)}${isSwitchingAudioRef.current ? ' · áudio alternativo' : ''}`);
        }}
        onPause={() => {
          const videoEl =
            playerRef.current?.el?.querySelector('video') ||
            (document.querySelector('video') as HTMLVideoElement | null);

          // Se o elemento nativo não está pausado (ex: stall temporário de stream), não marca como pausado
          if (videoEl && !videoEl.paused) {
            return;
          }

          setPaused(true);
          setControlsVisible(true);
          logger.action(`[Player] Pause em ${formatTime(lastKnownTimeRef.current)}${isSwitchingAudioRef.current ? ' · áudio alternativo' : ''}`);
        }}
        onDurationChange={(d) => {
          if (totalDurationRef.current > 0) {
            // Preserva a duração real do episódio detectada via FFmpeg ou metadados
            setDuration(totalDurationRef.current);
            return;
          }

          if (d && isFinite(d) && d > 0) {
            totalDurationRef.current = d;
            setDuration(d);
          }
        }}
        onProgress={(detail) => {
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
        }}
        onWaiting={() => {
          setIsBuffering(true);
          logger.warn('[Player] Carregando buffer…');
        }}
        onError={(err: any) => {
          sessionManager.updateRunStatus('failed');
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
        }}
        className={`w-full h-full aspect-${aspectMode} ${
          aspectMode === 'stretch'
            ? 'aspect-stretch object-fill [&_video]:!object-fill [&_video]:!w-full [&_video]:!h-full'
            : aspectMode === 'fill'
            ? 'aspect-fill object-cover [&_video]:!object-cover [&_video]:!w-full [&_video]:!h-full'
            : 'aspect-fit object-contain [&_video]:!object-contain [&_video]:!w-full [&_video]:!h-full'
        }`}
      >
        <MediaProvider className="w-full h-full flex items-center justify-center [&_video]:!max-w-none [&_video]:!max-h-none [&_video]:!w-full [&_video]:!h-full">
          {/* Subtitle Tracks: Apenas faixas WebVTT no Track nativo; faixas ASS/SSA são gerenciadas via LibASS/JASSUB */}
          {detectedSubtitles
            .filter((track) => track.type === 'vtt')
            .map((track) => (
              <Track
                key={track.src}
                src={track.src}
                kind="subtitles"
                label={track.label}
                lang={track.language}
                type={track.type}
                default={track.default}
              />
            ))}
        </MediaProvider>
        <Captions className="vds-captions" />
      </MediaPlayer>

      {/* Legenda obrigatória sendo preparada (PlaybackReadiness v8) */}
      {isPreparingSubtitle && readiness.selectedSubtitle.required && !subtitleFailurePrompt && (
        <div
          role="status"
          className={`absolute top-5 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2.5 px-4 py-2.5 rounded-[10px] text-[13px] font-medium whitespace-nowrap pointer-events-none ${floatingCard}`}
        >
          <Spinner size={16} className="text-lu-accent" />
          <span>
            Sincronizando legenda <strong className="font-semibold text-lu-accent">{activeSubtitle?.label}</strong>…
          </span>
        </div>
      )}

      {/* Falha na legenda obrigatória (Gating v8) */}
      {subtitleFailurePrompt && readiness.selectedSubtitle.required && (
        <div id="subtitle-failure-prompt" className="absolute top-5 left-1/2 -translate-x-1/2 z-40 w-[92%] max-w-[440px] pointer-events-auto">
          <div role="alert" className={`rounded-[14px] p-4 flex flex-col gap-3 ${floatingCard} border-lu-error/30`}>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 flex-none rounded-[10px] bg-lu-error/12 border border-lu-error/30 flex items-center justify-center text-lu-error">
                <TriangleAlert size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold">Não deu pra carregar a legenda</div>
                <div className="text-[13px] text-lu-muted truncate">
                  {subtitleFailurePrompt.track.label}
                  {subtitleFailurePrompt.code ? ` · ${subtitleFailurePrompt.code}` : ''}
                </div>
                <p className="mt-1 mb-0 text-[12px] text-lu-muted">{subtitleFailurePrompt.error}</p>
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {detectedSubtitles.some(
                (s) => !failedSubtitleSrcsRef.current.has(s.src) && s.src !== subtitleFailurePrompt.track.src
              ) && (
                <PrimaryButton onClick={handleTryNextSubtitle}>
                  <RefreshCw size={16} />
                  <span>Tentar a próxima</span>
                </PrimaryButton>
              )}
              <GhostButton onClick={handleWatchWithoutSubtitle}>Assistir sem legenda</GhostButton>
            </div>
          </div>
        </div>
      )}

      {/* Erro de reprodução (Player · Erro de stream) */}
      {playbackError && !isSwitchingAudioRef.current && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-lu-video/92 backdrop-blur-md select-text">
          {onBack && (
            <div className="absolute top-5 left-4 sm:left-6">
              <IconButton label="Voltar" onClick={onBack}>
                <ChevronLeft size={20} />
              </IconButton>
            </div>
          )}
          <div role="alert" className="flex flex-col items-center text-center gap-4 max-w-[460px] px-6">
            <div className="w-14 h-14 rounded-[14px] bg-lu-error/12 border border-lu-error/30 flex items-center justify-center text-lu-error">
              <TriangleAlert size={26} />
            </div>
            <h2 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">{playbackError.title}</h2>
            <span className="inline-block px-3 py-1.5 rounded-md bg-lu-bg2 border border-lu-border font-mono text-[12px] text-lu-muted break-all">
              {playbackError.message}
              {playbackError.code ? ` (Code ${playbackError.code})` : ''}
            </span>
            <p className="m-0 text-[14px] text-lu-muted">{playbackError.hint}</p>
            <div className="flex flex-wrap justify-center gap-2 mt-1">
              <PrimaryButton
                onClick={() => {
                  setPlaybackError(null);
                  setResolvedStreamUrl(`/api/proxy?url=${encodeURIComponent(source.src)}#.mp4`);
                  const videoEl = playerRef.current?.el?.querySelector('video');
                  if (videoEl) {
                    videoEl.load();
                  }
                }}
              >
                <RefreshCw size={18} />
                <span>Reconectar stream</span>
              </PrimaryButton>
              {onResetToWorkingPreset && (
                <GhostButton
                  onClick={() => {
                    setPlaybackError(null);
                    onResetToWorkingPreset();
                  }}
                >
                  <Play size={18} />
                  <span>Preset Sintel 1080p</span>
                </GhostButton>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Buffering */}
      {isBuffering && !paused && !playbackError && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none -mt-5">
          <div role="status" className={`flex items-center gap-3.5 px-5 py-3.5 rounded-[14px] ${floatingCard}`}>
            <Spinner size={22} className="text-lu-accent" />
            <div>
              <div className="text-[14px] font-semibold">Carregando buffer da mídia…</div>
              <div className="text-[13px] tabular text-lu-muted">
                Buffer acumulado: +{bufferAheadNow.toFixed(1).replace('.', ',')} s
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Espectador: vídeo pausado pelo Host */}
      {paused && isViewer && !playbackError && (
        <div id="host-paused-fixed-overlay" className="absolute inset-0 z-[35] flex items-center justify-center pointer-events-none px-4">
          <div role="status" className={`flex items-center gap-4 max-w-[440px] px-5 py-4 rounded-[14px] ${floatingCard}`}>
            <div className="w-11 h-11 flex-none rounded-[10px] bg-lu-tint text-lu-accent flex items-center justify-center">
              <Pause size={20} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[14px] font-semibold">
                <Crown size={14} className="flex-none" />
                <span className="truncate">Vídeo pausado por {pausedByName}</span>
              </div>
              <div className="mt-0.5 text-[13px] text-lu-muted">
                A reprodução continuará automaticamente quando o Host der play.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Clique no vídeo: play/pause; duplo clique: tela cheia */}
      <div
        id="player-click-backdrop"
        className="absolute inset-0 z-10 cursor-pointer"
        onClick={handlePlayToggle}
        onDoubleClick={handleFullscreenToggle}
      />

      {/* Retomar de onde parou */}
      {resumePrompt && (!syncStatus.isConnected || syncStatus.isHost) && (
        <div id="resume-playback-prompt" className="absolute bottom-[108px] left-3 sm:left-6 z-40 pointer-events-auto">
          <div className={`flex items-center gap-3 p-2.5 pl-3 rounded-[14px] ${floatingCard}`}>
            <span className="w-9 h-9 flex-none rounded-[10px] bg-lu-tint text-lu-accent flex items-center justify-center">
              <RotateCcw size={16} />
            </span>
            <div className="min-w-0">
              <div className="text-[12px] text-lu-muted">Continuar de onde parou?</div>
              <div className="text-[14px] font-semibold tabular">{resumePrompt.formatted}</div>
            </div>
            <PrimaryButton onClick={handleResumePlayback} className="!h-9 !px-3.5 text-[13px]">
              Retomar
            </PrimaryButton>
            <IconButton label="Fechar e assistir do início" size={36} tone="muted" onClick={() => setResumePrompt(null)}>
              <X size={16} />
            </IconButton>
          </div>
        </div>
      )}

      {/* Pular abertura / encerramento / resumo (Player · Pular abertura) */}
      {skippableChapter && !isViewer && (
        <button
          id="skip-chapter-prompt"
          type="button"
          aria-label={`${skippableChapter.label} (N)`}
          title={`${skippableChapter.label}: avançar para ${formatTime(skippableChapter.targetTime)}`}
          onClick={(e) => {
            e.stopPropagation();
            logger.action(`[Player] ${skippableChapter.label} → ${formatTime(skippableChapter.targetTime)}`);
            handleSeek(skippableChapter.targetTime);
          }}
          className={`absolute z-40 inline-flex items-center gap-2.5 h-12 px-4 rounded-[10px] overflow-hidden bg-lu-surface/84 backdrop-blur-md border border-white/14 text-[14px] font-semibold hover:bg-lu-elevated transition-[bottom,right,background-color] duration-200 ${
            showControls ? 'right-3 sm:right-6 bottom-[108px]' : 'right-4 sm:right-8 bottom-6 sm:bottom-8'
          }`}
        >
          <FastForward size={18} />
          <span>{skippableChapter.label}</span>
          <span className="hidden sm:inline-flex">
            <Kbd>N</Kbd>
          </span>
          <span className="absolute left-0 bottom-0 h-0.5 bg-lu-accent" style={{ width: `${skipProgress}%` }} />
        </button>
      )}

      {/* Controles (somem após 3 s de inatividade) */}
      <div
        className={`absolute inset-0 z-30 transition-opacity duration-300 ${
          showControls ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        <PlayerControls
          title={mediaTitle}
          paused={paused}
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          bufferedRanges={bufferedRanges}
          isInspecting={isInspecting}
          parsedMetadata={parsedMetadata}
          volume={volume}
          muted={muted}
          playbackRate={playbackRate}
          volumeBoost={volumeBoost}
          isFullscreen={isFullscreen}
          isPip={isPip}
          canPip={canPip}
          aspectCover={aspectMode !== 'fit'}
          aspectMode={aspectMode}
          chapters={normalizedChapters}
          subtitles={detectedSubtitles}
          activeSubtitle={activeSubtitle}
          audioTracks={detectedAudioTracks}
          activeAudioTrack={activeAudioTrack}
          onPlayToggle={handlePlayToggle}
          onSeek={handleSeek}
          onVolumeChange={handleVolumeChange}
          onMuteToggle={handleMuteToggle}
          onPlaybackRateChange={handlePlaybackRateChange}
          onVolumeBoostChange={handleVolumeBoostChange}
          audioDelay={audioDelay}
          onAudioDelayChange={handleAudioDelayChange}
          subtitleDelay={subtitleDelay}
          onSubtitleDelayChange={handleSubtitleDelayChange}
          subtitleFontSize={subtitleFontSize}
          onSubtitleFontSizeChange={handleSubtitleFontSizeChange}
          onFullscreenToggle={handleFullscreenToggle}
          onPipToggle={handlePipToggle}
          onToggleAspect={handleToggleAspect}
          onSubtitleChange={(sub) => {
            setActiveSubtitle(sub);
            if (!syncManager.isApplyingRemoteUpdate && syncManager.isRoomHost()) {
              syncManager.emitSubtitleTrack(sub ? sub.src : '');
            }
          }}
          onAudioTrackChange={handleAudioTrackChange}
          onWatchPartyToggle={handleToggleWatchParty}
          watchPartyMembersCount={syncStatus.membersCount}
          isWatchPartyConnected={syncStatus.isConnected}
          isHost={syncStatus.isHost}
          unreadChatCount={unreadChatCount}
          onBack={isFullscreen ? undefined : onBack}
          onAddSubtitle={onAddSubtitle}
          onMenuOpenChange={handleMenuOpenChange}
        />
      </div>

      {/* Com os controles escondidos, sobra só uma linha fina de progresso (Player · Inativo) */}
      {!showControls && (
        <div
          aria-hidden="true"
          className="absolute left-0 bottom-0 h-0.5 bg-lu-accent/70 z-20 pointer-events-none"
          style={{ width: `${progressPct}%` }}
        />
      )}

      {/* OSD: atalhos de sincronia, tamanho de legenda, ajuste de tela e eventos da sala */}
      {(osdToast || aspectToast || syncToast) && (
        <div className="absolute top-[84px] left-1/2 -translate-x-1/2 z-[45] flex flex-col items-center gap-2 pointer-events-none">
          {(osdToast || aspectToast) && (
            <div
              id="player-sync-osd-toast"
              role="status"
              className="flex items-center gap-2.5 px-4 py-2.5 rounded-[10px] bg-lu-elevated/94 backdrop-blur-md border border-lu-border shadow-[0_8px_24px_rgba(0,0,0,0.45)] text-[13px] font-medium tabular whitespace-nowrap"
            >
              <Dot tone="accent" />
              {osdToast ? osdToast.text : aspectToast}
            </div>
          )}
          {syncToast && (
            <div
              role="status"
              className="flex items-center gap-2.5 px-4 py-2.5 rounded-[10px] bg-lu-elevated/94 backdrop-blur-md border border-lu-border shadow-[0_8px_24px_rgba(0,0,0,0.45)] text-[13px] font-medium whitespace-nowrap"
            >
              <Dot tone="accent" />
              {syncToast}
            </div>
          )}
        </div>
      )}

      {/* Mensagens do chat com o painel fechado (até 3) */}
      {!isWatchPartyOpen && chatToasts.length > 0 && (
        <div className="absolute top-16 right-4 sm:right-6 z-40 flex flex-col gap-2 pointer-events-none w-[300px] max-w-[calc(100%-32px)]">
          {chatToasts.map((toast) => (
            <button
              key={toast.id}
              type="button"
              onClick={() => {
                handleToggleWatchParty();
                setChatToasts([]);
              }}
              className={`flex items-center gap-3 p-3 rounded-[14px] text-left pointer-events-auto hover:bg-lu-elevated transition-colors ${floatingCard}`}
            >
              <Avatar name={toast.username} url={toast.avatarUrl} size={32} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[12px] text-lu-muted">
                  <MessageSquare size={12} />
                  {toast.username}
                </span>
                <span className="block text-[14px] truncate">{toast.text}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Cantos arredondados "falsos": o container é retangular e esta moldura pinta os cantos com a cor da página.
          Recortar o <video> com border-radius faz o Chromium no Windows (overlay de hardware) mostrar tela preta
          enquanto nada está por cima do vídeo; em tela cheia não há cantos, por isso lá não acontecia. */}
      {!isFullscreen && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[45] hidden sm:block rounded-[18px] border border-lu-border shadow-[0_0_0_24px_var(--color-lu-bg)]"
        />
      )}

      <WatchPartyPanel isOpen={isWatchPartyOpen} onClose={handleCloseWatchParty} onOpenRoomLobby={onOpenRoomLobby} onLeaveRoom={onLeaveRoom} />
    </div>
  );
};
