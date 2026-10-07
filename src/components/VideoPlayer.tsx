import React, { useRef, useState, useEffect } from 'react';
import {
  MediaPlayer,
  MediaProvider,
  Track,
  Captions,
  type MediaPlayerInstance,
} from '@vidstack/react';
import '@vidstack/react/player/styles/base.css';

import { MediaSource, Chapter, SubtitleTrack, AudioTrackOption } from '../types/media';
import { PlayerControls } from './PlayerControls';
import { WatchPartyPanel } from './WatchPartyPanel';
import { audioBoost } from '../lib/audioBoost';
import { normalizeChapters, getCurrentChapter, getSkippableChapter } from '../lib/chapters';
import { logger } from '../lib/logger';
import { formatTime } from '../lib/chapters';
import { syncManager } from '../lib/sync';
import {
  BufferingOverlay,
  ChatToasts,
  HostPausedOverlay,
  PlaybackErrorOverlay,
  PlayerToasts,
  ResumePrompt,
  RoundedCornersFrame,
  SkipChapterButton,
  StandbyScreen,
  SubtitleFailurePrompt,
  SubtitlePreparingBadge,
} from './player/overlays';
import { useAlternateAudio } from './player/useAlternateAudio';
import { useControlsVisibility } from './player/useControlsVisibility';
import { useFullscreen } from './player/useFullscreen';
import { useMediaInspection } from './player/useMediaInspection';
import { useNativeVideoEvents } from './player/useNativeVideoEvents';
import { usePlaybackControls } from './player/usePlaybackControls';
import { usePlaybackReadiness } from './player/usePlaybackReadiness';
import { usePlayerEventHandlers } from './player/usePlayerEventHandlers';
import { usePlayerPrefs } from './player/usePlayerPrefs';
import { usePlayerShortcuts } from './player/usePlayerShortcuts';
import { useRoomSync } from './player/useRoomSync';
import { useSubtitles } from './player/useSubtitles';

export type { AspectMode } from './player/usePlayerPrefs';

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

/**
 * Player de vídeo do Lunio. Aqui fica só a composição: o estado compartilhado, a ordem dos hooks (em ./player/*) e a renderização.
 *  - useRoomSync: sala (play/pause/seek/rate do Host, drift do espectador, chat)
 *  - useAlternateAudio: URL do stream e troca de dublagem (remux)
 *  - useSubtitles / useMediaInspection: faixas, ranking e gating de legenda
 *  - usePlaybackControls / usePlayerShortcuts / useControlsVisibility / useFullscreen: interação
 */
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
  const currentChapterRef = useRef<Chapter | null>(null);

  // Playback error diagnostics
  const [playbackError, setPlaybackError] = useState<{
    title: string;
    message: string;
    hint: string;
    code?: number;
  } | null>(null);

  // Player state
  const [paused, setPaused] = useState<boolean>(true);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [buffered, setBuffered] = useState<number>(0);
  const [bufferedRanges, setBufferedRanges] = useState<{ start: number; end: number }[]>([]);
  const [mediaTitle, setMediaTitle] = useState<string>(title || '');
  const [parsedMetadata, setParsedMetadata] = useState<any>(null);
  const [isBuffering, setIsBuffering] = useState<boolean>(false);
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
  const [canPip, setCanPip] = useState<boolean>(false);
  // Prompt flutuante para retomar reprodução do momento anterior
  const [resumePrompt, setResumePrompt] = useState<{ time: number; formatted: string } | null>(null);

  const hasSource = Boolean(source.src && source.src.trim());

  // Preferências locais, tela cheia e legendas
  const prefs = usePlayerPrefs();
  const fullscreen = useFullscreen(playerRef, containerRef);
  const subs = useSubtitles({ playerRef, audioOffsetRef, setPaused, initialSubtitles });
  const { detectedSubtitles, readiness, setReadiness, activeSubtitle, setActiveSubtitle } = subs;

  // Stream e áudio alternativo
  const audio = useAlternateAudio({
    source,
    playerRef,
    paused,
    currentTime,
    setIsBuffering,
    setCurrentTime,
    isSwitchingAudioRef,
    audioOffsetRef,
    wasPlayingBeforeAudioSwitchRef,
    initialAudioTracks,
  });
  const { detectedAudioTracks, activeAudioTrack, resolvedStreamUrl, setResolvedStreamUrl } = audio;

  // Leitura das faixas ao mudar a fonte
  const { detectedChapters, isInspecting } = useMediaInspection({
    source,
    hasSource,
    title,
    initialChapters,
    initialSubtitles,
    initialAudioTracks,
    audio,
    subs,
    currentChapterRef,
    pendingPlayRef,
    totalDurationRef,
    setPlaybackError,
    setResumePrompt,
    setMediaTitle,
    setParsedMetadata,
    setDuration,
  });

  // Sala (Watch Party)
  const room = useRoomSync({
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
  });
  const { syncStatus, setSyncToast, isWatchPartyOpen, handleToggleWatchParty, handleCloseWatchParty } = room;

  // Capítulos
  const normalizedChapters = normalizeChapters(detectedChapters, duration);
  const normalizedChaptersRef = useRef<Chapter[]>(normalizedChapters);
  normalizedChaptersRef.current = normalizedChapters;

  // Detecção de capítulo pulável (Abertura / Encerramento / Recap) estilo Netflix / Crunchyroll
  const skippableChapter = React.useMemo(() => {
    return getSkippableChapter(currentTime, normalizedChapters);
  }, [currentTime, normalizedChapters]);

  const controls = useControlsVisibility(paused);

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

  useNativeVideoEvents({
    playerRef,
    resolvedStreamUrl,
    source,
    resumePrompt,
    isSwitchingAudioRef,
    audioOffsetRef,
    totalDurationRef,
    isExplicitSeekingRef,
    lastKnownTimeRef,
    wasPlayingBeforeSeekRef,
    handleSeekRef,
    currentChapterRef,
    normalizedChaptersRef,
    setBuffered,
    setBufferedRanges,
    setCurrentTime,
    setPaused,
    setIsBuffering,
    setResumePrompt,
  });

  const playback = usePlaybackControls({
    playerRef,
    source,
    title,
    mediaTitle,
    duration,
    currentTime,
    paused,
    muted,
    syncStatus,
    detectedChapters,
    detectedSubtitles,
    detectedAudioTracks,
    resumePrompt,
    remuxFrom: audio.remuxFrom,
    isSwitchingAudioRef,
    audioOffsetRef,
    wasPlayingBeforeAudioSwitchRef,
    wasPlayingBeforeSeekRef,
    pendingPlayRef,
    lastKnownTimeRef,
    isExplicitSeekingRef,
    handleSeekRef,
    setPaused,
    setCurrentTime,
    setIsBuffering,
    setResumePrompt,
    setSyncToast,
    setVolume,
    setMuted,
    setPlaybackRate,
    setVolumeBoost: prefs.setVolumeBoost,
  });

  usePlaybackReadiness({ readiness, autoPlay, paused, setPaused, playerRef, source, handleSeekRef, pendingPlayRef });

  usePlayerShortcuts({
    currentTime,
    duration,
    volume,
    muted,
    paused,
    activeSubtitle,
    detectedSubtitles,
    isFullscreen: fullscreen.isFullscreen,
    syncStatus,
    skippableChapter,
    subtitleDelay: prefs.subtitleDelay,
    audioDelay: prefs.audioDelay,
    lastKnownTimeRef,
    setSyncToast,
    setActiveSubtitle,
    triggerFullscreenVisuals: fullscreen.triggerFullscreenVisuals,
    handlePlayToggle: playback.handlePlayToggle,
    handleSeek: playback.handleSeek,
    handleVolumeChange: playback.handleVolumeChange,
    handleMuteToggle: playback.handleMuteToggle,
    handleFullscreenToggle: fullscreen.handleFullscreenToggle,
    handleToggleAspect: prefs.handleToggleAspect,
    handleToggleWatchParty,
    handleSubtitleDelayChange: prefs.handleSubtitleDelayChange,
    handleAudioDelayChange: prefs.handleAudioDelayChange,
  });

  const playerEvents = usePlayerEventHandlers({
    playerRef,
    source,
    autoPlay,
    paused,
    currentTime,
    resolvedStreamUrl,
    setResolvedStreamUrl,
    isSwitchingAudioRef,
    audioOffsetRef,
    totalDurationRef,
    wasPlayingBeforeAudioSwitchRef,
    pendingPlayRef,
    lastKnownTimeRef,
    setPlaybackError,
    setReadiness,
    setDuration,
    setPaused,
    setCurrentTime,
    setIsBuffering,
    setBuffered,
    setBufferedRanges,
    setControlsVisible: controls.setControlsVisible,
  });

  const { aspectMode } = prefs;
  const { isFullscreen } = fullscreen;

  if (!hasSource) {
    const canChoose = Boolean(onChooseVideo) && (!syncStatus.isConnected || syncStatus.isHost);
    return (
      <StandbyScreen
        canChoose={canChoose}
        isConnected={syncStatus.isConnected}
        membersCount={syncStatus.membersCount}
        isWatchPartyOpen={isWatchPartyOpen}
        onChooseVideo={onChooseVideo}
        onToggleWatchParty={handleToggleWatchParty}
        onCloseWatchParty={handleCloseWatchParty}
        onOpenRoomLobby={onOpenRoomLobby}
        onLeaveRoom={onLeaveRoom}
      />
    );
  }

  const { controlsVisible, resetControlsTimer, handleMenuOpenChange } = controls;
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
    room.hostPausedInfo?.username || syncManager.getRoomState()?.members.find((m) => m.isHost)?.username || 'Host';

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
        src={audio.mediaSource}
        // Remux fMP4 não aceita seek (seekable = 0–0): sem a duração real o Vidstack calcula duration = 0 e,
        // a cada play depois de um pause, "reinicia" o trecho do começo. Informar a duração evita isso.
        duration={audio.isRemuxStream && duration > 0 ? duration : undefined}
        autoPlay={autoPlay && (!readiness.selectedSubtitle.required || (readiness.selectedSubtitle.ready && !readiness.selectedSubtitle.failed))}
        playsInline
        logLevel="warn"
        playbackRate={playbackRate}
        volume={volume}
        muted={muted}
        onCanPlay={playerEvents.onCanPlay}
        onTimeUpdate={playerEvents.onTimeUpdate}
        onPlay={playerEvents.onPlay}
        onPause={playerEvents.onPause}
        onDurationChange={playerEvents.onDurationChange}
        onProgress={playerEvents.onProgress}
        onWaiting={playerEvents.onWaiting}
        onError={playerEvents.onError}
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
      {subs.isPreparingSubtitle && readiness.selectedSubtitle.required && !subs.subtitleFailurePrompt && (
        <SubtitlePreparingBadge label={activeSubtitle?.label} />
      )}

      {/* Falha na legenda obrigatória (Gating v8) */}
      {subs.subtitleFailurePrompt && readiness.selectedSubtitle.required && (
        <SubtitleFailurePrompt
          prompt={subs.subtitleFailurePrompt}
          hasNext={Boolean(subs.findNextSubtitle())}
          onTryNext={subs.handleTryNextSubtitle}
          onWatchWithout={subs.handleWatchWithoutSubtitle}
        />
      )}

      {/* Erro de reprodução (Player · Erro de stream) */}
      {playbackError && !isSwitchingAudioRef.current && (
        <PlaybackErrorOverlay
          error={playbackError}
          onBack={onBack}
          onReconnect={() => {
            setPlaybackError(null);
            setResolvedStreamUrl(`/api/proxy?url=${encodeURIComponent(source.src)}#.mp4`);
            const videoEl = playerRef.current?.el?.querySelector('video');
            if (videoEl) {
              videoEl.load();
            }
          }}
          onResetToWorkingPreset={
            onResetToWorkingPreset
              ? () => {
                  setPlaybackError(null);
                  onResetToWorkingPreset();
                }
              : undefined
          }
        />
      )}

      {/* Buffering */}
      {isBuffering && !paused && !playbackError && <BufferingOverlay bufferAheadNow={bufferAheadNow} />}

      {/* Espectador: vídeo pausado pelo Host */}
      {paused && isViewer && !playbackError && <HostPausedOverlay pausedByName={pausedByName} />}

      {/* Clique no vídeo: play/pause; duplo clique: tela cheia */}
      <div
        id="player-click-backdrop"
        className="absolute inset-0 z-10 cursor-pointer"
        onClick={playback.handlePlayToggle}
        onDoubleClick={fullscreen.handleFullscreenToggle}
      />

      {/* Retomar de onde parou */}
      {resumePrompt && (!syncStatus.isConnected || syncStatus.isHost) && (
        <ResumePrompt prompt={resumePrompt} onResume={playback.handleResumePlayback} onDismiss={() => setResumePrompt(null)} />
      )}

      {/* Pular abertura / encerramento / resumo (Player · Pular abertura) */}
      {skippableChapter && !isViewer && (
        <SkipChapterButton
          chapter={skippableChapter}
          showControls={showControls}
          skipProgress={skipProgress}
          onSkip={() => {
            logger.action(`[Player] ${skippableChapter.label} → ${formatTime(skippableChapter.targetTime)}`);
            playback.handleSeek(skippableChapter.targetTime);
          }}
        />
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
          volumeBoost={prefs.volumeBoost}
          isFullscreen={isFullscreen}
          isPip={fullscreen.isPip}
          canPip={canPip}
          aspectCover={aspectMode !== 'fit'}
          aspectMode={aspectMode}
          chapters={normalizedChapters}
          subtitles={detectedSubtitles}
          activeSubtitle={activeSubtitle}
          audioTracks={detectedAudioTracks}
          activeAudioTrack={activeAudioTrack}
          onPlayToggle={playback.handlePlayToggle}
          onSeek={playback.handleSeek}
          onVolumeChange={playback.handleVolumeChange}
          onMuteToggle={playback.handleMuteToggle}
          onPlaybackRateChange={playback.handlePlaybackRateChange}
          onVolumeBoostChange={playback.handleVolumeBoostChange}
          audioDelay={prefs.audioDelay}
          onAudioDelayChange={prefs.handleAudioDelayChange}
          subtitleDelay={prefs.subtitleDelay}
          onSubtitleDelayChange={prefs.handleSubtitleDelayChange}
          subtitleFontSize={prefs.subtitleFontSize}
          onSubtitleFontSizeChange={prefs.handleSubtitleFontSizeChange}
          onFullscreenToggle={fullscreen.handleFullscreenToggle}
          onPipToggle={fullscreen.handlePipToggle}
          onToggleAspect={prefs.handleToggleAspect}
          // Legenda selecionada é estado local: nada é enviado à sala
          onSubtitleChange={(sub) => setActiveSubtitle(sub)}
          onAudioTrackChange={audio.handleAudioTrackChange}
          onWatchPartyToggle={handleToggleWatchParty}
          watchPartyMembersCount={syncStatus.membersCount}
          isWatchPartyConnected={syncStatus.isConnected}
          isHost={syncStatus.isHost}
          unreadChatCount={room.unreadChatCount}
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
      {(prefs.osdToast || prefs.aspectToast || room.syncToast) && (
        <PlayerToasts osdToast={prefs.osdToast} aspectToast={prefs.aspectToast} syncToast={room.syncToast} />
      )}

      {/* Mensagens do chat com o painel fechado (até 3) */}
      {!isWatchPartyOpen && room.chatToasts.length > 0 && (
        <ChatToasts
          toasts={room.chatToasts}
          onOpen={() => {
            handleToggleWatchParty();
            room.setChatToasts([]);
          }}
        />
      )}

      {/* Cantos arredondados "falsos": o container é retangular e esta moldura pinta os cantos com a cor da página.
          Recortar o <video> com border-radius faz o Chromium no Windows (overlay de hardware) mostrar tela preta
          enquanto nada está por cima do vídeo; em tela cheia não há cantos, por isso lá não acontecia. */}
      {!isFullscreen && <RoundedCornersFrame />}

      <WatchPartyPanel isOpen={isWatchPartyOpen} onClose={handleCloseWatchParty} onOpenRoomLobby={onOpenRoomLobby} onLeaveRoom={onLeaveRoom} />
    </div>
  );
};
