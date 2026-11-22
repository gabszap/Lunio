import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  Maximize,
  Minimize,
  PictureInPicture2,
  Captions,
  AudioWaveform,
  Maximize2,
  RotateCcw,
  RotateCw,
  Plus,
  SkipForward,
  ListVideo,
  RefreshCw,
} from 'lucide-react';
import { Chapter, SubtitleTrack, AudioTrackOption, CatalogSeriesContext } from '../types/media';
import type { CatalogEpisode } from '../lib/catalog';
import type { StreamOption } from '../lib/streams';
import { formatTime } from '../lib/chapters';
import { SeekButtons } from './SeekButtons';
import { VolumeDisplay } from './VolumeDisplay';
import { SettingsMenu, formatMs, type VideoQualityOption } from './SettingsMenu';
import { ChapterTimeline } from './ChapterTimeline';
import { ChapterList } from './ChapterList';
import { EpisodesOverlay } from './EpisodesMenu';
import { t, msg } from '../lib/i18n';
import {
  Badge,
  Chip,
  ChipRow,
  Dot,
  IconButton,
  MenuDivider,
  MenuItem,
  MenuPanel,
  MenuSection,
  Slider,
  Spinner,
  cx,
  useDismiss,
} from './ui';

interface PlayerControlsProps {
  title?: string;
  paused: boolean;
  currentTime: number;
  duration: number;
  buffered: number;
  bufferedRanges?: { start: number; end: number }[];
  isInspecting?: boolean;
  parsedMetadata?: any;
  /** Resolução detectada ao vivo (ex.: YouTube playbackQuality ou videoHeight real). */
  liveResolution?: string | null;
  qualities?: VideoQualityOption[];
  autoQuality?: boolean;
  onQualitySelect?: (height: number | 'auto') => void;
  volume: number;
  muted: boolean;
  playbackRate: number;
  volumeBoost: number;
  isFullscreen: boolean;
  isPip: boolean;
  canPip: boolean;
  chapters: Chapter[];
  subtitles: SubtitleTrack[];
  activeSubtitle: SubtitleTrack | null;
  audioTracks: AudioTrackOption[];
  activeAudioTrack: AudioTrackOption | null;
  onPlayToggle: () => void;
  onSeek: (time: number) => void;
  onVolumeChange: (volume: number) => void;
  onMuteToggle: () => void;
  onPlaybackRateChange: (rate: number) => void;
  onVolumeBoostChange: (boost: number) => void;
  autoSkipIntro?: boolean;
  onAutoSkipIntroChange?: (on: boolean) => void;
  audioDelay?: number;
  onAudioDelayChange?: (delay: number) => void;
  subtitleDelay?: number;
  onSubtitleDelayChange?: (delay: number) => void;
  subtitleFontSize?: number;
  onSubtitleFontSizeChange?: (size: number) => void;
  subtitleBottomOffset?: number;
  onSubtitleBottomOffsetChange?: (offset: number) => void;
  aspectCover?: boolean;
  aspectMode?: 'fit' | 'fill' | 'stretch';
  onToggleAspect?: () => void;
  onFullscreenToggle: () => void;
  onPipToggle: () => void;
  onSubtitleChange: (track: SubtitleTrack | null) => void;
  onAudioTrackChange: (track: AudioTrackOption | null) => void;
  onWatchPartyToggle?: () => void;
  watchPartyMembersCount?: number;
  isWatchPartyConnected?: boolean;
  isHost?: boolean;
  unreadChatCount?: number;
  onBack?: () => void;
  onAddSubtitle?: () => void;
  seriesContext?: CatalogSeriesContext | null;
  onSelectEpisodeStream?: (episode: CatalogEpisode, stream: StreamOption) => void;
  /** Abre o overlay de episódios diretamente em um episódio alvo (ex.: cartão "Próximo episódio"). */
  externalEpisodesTarget?: CatalogEpisode | null;
  onExternalEpisodesTargetConsumed?: () => void;
  /** Próximo da fila da sala (só existe dentro de uma sala, para o Host). Sem itens na fila o botão fica desativado. */
  onNext?: () => void;
  hasNext?: boolean;
  /** Diferença (s) do espectador para o Host (positivo = atrasado); clicando no selo sincroniza na hora. */
  viewerBehindSec?: number;
  onResync?: () => void;
  /** Avisado quando algum menu abre/fecha, para o player não esconder os controles com menu aberto. */
  onMenuOpenChange?: (open: boolean) => void;
}

function getIsoLanguageCode(lang?: string, title?: string): string {
  const l = (lang || '').toLowerCase();
  const t = (title || '').toLowerCase();

  // Variantes regionais específicas (estilo mpv BCP-47)
  if (t.includes('brazil') || t.includes('brasil') || l.includes('pt-br')) return 'pt-BR';
  if (t.includes('portugal') || l.includes('pt-pt')) return 'pt-PT';
  if (t.includes('hong kong') || t.includes('hk') || l.includes('zh-hk')) return 'zh-HK';
  if (t.includes('mandar') || l.includes('cmn')) return 'cmn';
  if (t.includes('taiwan') || l.includes('zh-tw')) return 'zh-TW';
  if (t.includes('latin') || t.includes('419') || l.includes('es-419')) return 'es-419';
  if (t.includes('europe') || t.includes('spain') || l.includes('es-es')) return 'es-ES';
  if (t.includes('saudi') || l.includes('ar-sa')) return 'ar-SA';

  const isoMap: Record<string, string> = {
    por: 'pt', pt: 'pt',
    eng: 'en', en: 'en',
    spa: 'es', es: 'es',
    fra: 'fr', fre: 'fr', fr: 'fr',
    deu: 'de', ger: 'de', de: 'de',
    ita: 'it', it: 'it',
    rus: 'ru', ru: 'ru',
    jpn: 'ja', ja: 'ja',
    kor: 'ko', ko: 'ko',
    chi: 'zh', zho: 'zh', zh: 'zh',
    ara: 'ar', ar: 'ar',
    hin: 'hi', hi: 'hi',
    tur: 'tr', tr: 'tr',
    pol: 'pl', pl: 'pl',
    dut: 'nl', nld: 'nl', nl: 'nl',
    ind: 'id', id: 'id',
    may: 'ms', msa: 'ms', ms: 'ms',
    swe: 'sv', sv: 'sv',
    tha: 'th', th: 'th',
    vie: 'vi', vi: 'vi',
    ukr: 'uk', uk: 'uk',
    cze: 'cs', ces: 'cs', cs: 'cs',
    hun: 'hu', hu: 'hu',
    rum: 'ro', ron: 'ro', ro: 'ro',
    dan: 'da', da: 'da',
    nor: 'no', no: 'no',
    fin: 'fi', fi: 'fi',
    gre: 'el', ell: 'el', el: 'el',
    heb: 'he', he: 'he',
  };

  for (const [key, val] of Object.entries(isoMap)) {
    if (l === key || l.startsWith(key)) return val;
  }

  return l !== 'und' && l ? l : '';
}

function getSubtitleTag(track: SubtitleTrack): string {
  const iso = getIsoLanguageCode(track.language, track.label);
  const codec = (track.type || 'ass').toLowerCase();
  return iso ? `${iso} · ${codec}` : codec;
}

function getAudioTag(trk: AudioTrackOption): string {
  const iso = getIsoLanguageCode(trk.language, trk.label);
  const raw = (trk.codec || 'aac').toLowerCase();
  const codec = raw.includes('aac')
    ? 'aac'
    : raw.includes('ac3') || raw.includes('eac3')
    ? 'ac3'
    : raw.includes('dts')
    ? 'dts'
    : raw.includes('flac')
    ? 'flac'
    : raw.includes('opus')
    ? 'opus'
    : raw.split(' ')[0] || 'aac';

  return iso ? `${iso} · ${codec}` : codec;
}

/** Buffer contíguo à frente do playhead (nunca soma pedaços futuros desconectados). */
function getBufferAhead(currentTime: number, buffered: number, ranges?: { start: number; end: number }[]) {
  if (ranges && ranges.length > 0) {
    const active = ranges.find((r) => currentTime >= r.start - 1.5 && currentTime <= r.end + 0.5);
    return active ? Math.max(0, active.end - currentTime) : 0;
  }
  return Math.max(0, buffered - currentTime);
}

const ASPECT_LABEL: Record<'fit' | 'fill' | 'stretch', string> = {
  fit: msg('Ajuste de tela: original (Z)'),
  fill: msg('Ajuste de tela: preencher (Z)'),
  stretch: msg('Ajuste de tela: esticar (Z)'),
};

type MenuId = 'subs' | 'audio' | 'chapters' | 'episodes' | 'settings' | null;

export const PlayerControls: React.FC<PlayerControlsProps> = ({
  title,
  paused,
  currentTime,
  duration,
  buffered,
  bufferedRanges,
  isInspecting,
  parsedMetadata,
  liveResolution,
  qualities,
  autoQuality,
  onQualitySelect,
  volume,
  muted,
  playbackRate,
  volumeBoost,
  isFullscreen,
  isPip,
  canPip,
  chapters,
  subtitles,
  activeSubtitle,
  audioTracks,
  activeAudioTrack,
  onPlayToggle,
  onSeek,
  onVolumeChange,
  onMuteToggle,
  onPlaybackRateChange,
  onVolumeBoostChange,
  autoSkipIntro,
  onAutoSkipIntroChange,
  audioDelay = 0,
  onAudioDelayChange,
  subtitleDelay = 0,
  onSubtitleDelayChange,
  subtitleFontSize = 100,
  onSubtitleFontSizeChange,
  subtitleBottomOffset = 5,
  onSubtitleBottomOffsetChange,
  aspectMode = 'fit',
  onToggleAspect,
  onFullscreenToggle,
  onPipToggle,
  onSubtitleChange,
  onAudioTrackChange,
  onWatchPartyToggle,
  watchPartyMembersCount,
  isWatchPartyConnected,
  isHost,
  unreadChatCount = 0,
  onBack,
  onAddSubtitle,
  seriesContext,
  onSelectEpisodeStream,
  externalEpisodesTarget,
  onExternalEpisodesTargetConsumed,
  onNext,
  hasNext = false,
  viewerBehindSec = 0,
  onResync,
  onMenuOpenChange,
}) => {
  const [openMenu, setOpenMenuState] = useState<MenuId>(null);
  const [episodesTarget, setEpisodesTarget] = useState<CatalogEpisode | null>(null);
  const subMenuRef = useRef<HTMLDivElement>(null);
  const audioMenuRef = useRef<HTMLDivElement>(null);
  const episodesToggleRef = useRef<HTMLDivElement>(null);

  const setOpenMenu = useCallback(
    (id: MenuId) => {
      setOpenMenuState(id);
      if (id !== 'episodes') setEpisodesTarget(null);
      onMenuOpenChange?.(id !== null);
    },
    [onMenuOpenChange]
  );

  useEffect(() => {
    if (!externalEpisodesTarget) return;
    setEpisodesTarget(externalEpisodesTarget);
    setOpenMenu('episodes');
    onExternalEpisodesTargetConsumed?.();
  }, [externalEpisodesTarget, setOpenMenu, onExternalEpisodesTargetConsumed]);

  const toggleMenu = (id: Exclude<MenuId, null>) => setOpenMenu(openMenu === id ? null : id);
  const closeMenu = useCallback(() => setOpenMenu(null), [setOpenMenu]);

  useDismiss(openMenu === 'subs', closeMenu, subMenuRef);
  useDismiss(openMenu === 'audio', closeMenu, audioMenuRef);

  const isViewer = Boolean(isWatchPartyConnected && !isHost);
  const bufferAhead = getBufferAhead(currentTime, buffered, bufferedRanges);
  const showBuffer = duration > 0 || currentTime > 0 || buffered > 0;
  const bufferTone = bufferAhead >= 10 ? 'success' : bufferAhead >= 3 ? 'warning' : 'error';

  const episodeTitle = parsedMetadata?.episodeTitle ? String(parsedMetadata.episodeTitle) : '';
  const hasChapters = chapters.length > 0;
  const codecBadge = parsedMetadata?.codec ? String(parsedMetadata.codec).toUpperCase().replace('X265', 'HEVC').replace('X264', 'H.264') : null;

  return (
    <div id="player-ui-overlay" className="absolute inset-0 flex flex-col justify-between pointer-events-none">
      {/* Topo: título, capítulo atual clicável e selos técnicos (ações da sala ficam no cabeçalho e na dock) */}
      <div className="pointer-events-auto relative z-20 flex items-start justify-between gap-4 px-3 sm:px-6 pt-3 sm:pt-5 pb-14 bg-gradient-to-b from-lu-video/80 to-lu-video/0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className="min-w-0">
            <h2 id="player-media-title" className="m-0 text-[15px] sm:text-[16px] font-medium truncate">
              {title || t('Stream de vídeo')}
            </h2>
            {(hasChapters || episodeTitle || isInspecting) && (
              <div className="hidden sm:flex items-center gap-2 text-[13px] text-lu-muted min-w-0 mt-0.5">
                {isInspecting && (
                  <span className="inline-flex items-center gap-1.5 text-lu-accent flex-none">
                    <Spinner size={13} />
                    {t('Lendo faixas…')}
                  </span>
                )}
                {hasChapters && (
                  <ChapterList
                    chapters={chapters}
                    currentTime={currentTime}
                    onSeek={onSeek}
                    open={openMenu === 'chapters'}
                    onOpenChange={(o) => setOpenMenu(o ? 'chapters' : null)}
                    disabled={isViewer}
                  />
                )}
                {episodeTitle && (
                  <span className="truncate">
                    {hasChapters ? `· ${episodeTitle}` : episodeTitle}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="hidden sm:flex items-center gap-1.5 flex-none">
          {(liveResolution || parsedMetadata?.resolution) && <Badge>{liveResolution || parsedMetadata.resolution}</Badge>}
          {codecBadge && <Badge>{codecBadge}</Badge>}
          {volumeBoost > 100 && <Badge className="text-lu-success">Boost {volumeBoost}%</Badge>}
        </div>
      </div>

      {/* Overlay lateral de episódios */}
      {seriesContext && onSelectEpisodeStream && (
        <EpisodesOverlay
          seriesContext={seriesContext}
          open={openMenu === 'episodes'}
          onClose={closeMenu}
          toggleRef={episodesToggleRef}
          onSelectEpisodeStream={onSelectEpisodeStream}
          initialTargetEpisode={episodesTarget}
          isViewer={isViewer}
        />
      )}

      {/* Centro: clique pausa, duplo clique tela cheia */}
      <div
        id="player-center-click-area"
        className="flex-1 pointer-events-auto flex items-center justify-center select-none"
        onClick={onPlayToggle}
        onDoubleClick={onFullscreenToggle}
      >
        {!isViewer && (
          <>
            {/* Celular: −10 · play · +10 sempre no centro */}
            <div className="flex sm:hidden items-center gap-8" onClick={(e) => e.stopPropagation()}>
              <IconButton label={t('Voltar 10 segundos')} onClick={() => onSeek(Math.max(0, currentTime - 10))}>
                <RotateCcw size={22} />
              </IconButton>
              <button
                type="button"
                aria-label={paused ? 'Reproduzir' : 'Pausar'}
                onClick={onPlayToggle}
                className="w-16 h-16 rounded-full inline-flex items-center justify-center bg-lu-surface/72 border border-white/12 backdrop-blur-md text-lu-text"
              >
                {paused ? <Play size={24} className="ml-0.5" /> : <Pause size={24} />}
              </button>
              <IconButton
                label={t('Avançar 10 segundos')}
                onClick={() => onSeek(duration > 0 ? Math.min(duration, currentTime + 10) : currentTime + 10)}
              >
                <RotateCw size={22} />
              </IconButton>
            </div>
            {paused && (
              <button
                type="button"
                aria-label={t('Reproduzir')}
                onClick={(e) => {
                  e.stopPropagation();
                  onPlayToggle();
                }}
                className="hidden sm:inline-flex w-[76px] h-[76px] rounded-full items-center justify-center bg-lu-surface/72 border border-white/12 backdrop-blur-md text-lu-text hover:bg-lu-elevated transition-colors"
              >
                <Play size={30} className="ml-1" />
              </button>
            )}
          </>
        )}
      </div>

      {/* Base: timeline e barra de controles */}
      <div
        id="player-bottom-controls-bar"
        className="sm:@container pointer-events-auto flex flex-col gap-1 px-3 sm:px-4 @[980px]:px-6 pt-16 pb-2 sm:pb-3.5 bg-gradient-to-t from-lu-video/92 to-lu-video/0"
      >
        <ChapterTimeline
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          bufferedRanges={bufferedRanges}
          chapters={chapters}
          onSeek={onSeek}
          disabled={isViewer}
        />

        <div className="flex items-center justify-between gap-1.5 flex-wrap sm:flex-nowrap">
          <div className="flex items-center gap-0.5 @[980px]:gap-1 min-w-0 flex-none">
            {isViewer ? (
              <button
                id="viewer-sync-badge"
                type="button"
                onClick={onResync}
                title={t('Clique para re-sincronizar imediatamente com o Host da sala.')}
                className={cx(
                  'inline-flex items-center gap-2 h-9 @[980px]:h-11 px-3 @[980px]:px-3.5 box-border rounded-[10px] border text-[12px] @[980px]:text-[13px] font-semibold flex-none transition-colors',
                  Math.abs(viewerBehindSec) >= 1.5
                    ? 'bg-lu-warning/12 border-lu-warning/35 text-lu-warning hover:bg-lu-warning/20'
                    : 'bg-lu-success/10 border-lu-success/28 text-lu-success hover:bg-lu-success/18'
                )}
              >
                {Math.abs(viewerBehindSec) >= 1.5 ? (
                  <>
                    <RefreshCw size={13} />
                    <span className="tabular">
                      {viewerBehindSec > 0 ? `−${Math.round(viewerBehindSec)}s` : `+${Math.round(Math.abs(viewerBehindSec))}s`} · {t('Sincronizar')}
                    </span>
                  </>
                ) : (
                  <>
                    <Dot tone="success" />
                    <span>{t('Ao vivo')}</span>
                  </>
                )}
              </button>
            ) : (
              <>
                <button
                  id="btn-play-pause"
                  type="button"
                  aria-label={paused ? t('Reproduzir (Espaço)') : t('Pausar (Espaço)')}
                  title={paused ? t('Reproduzir (Espaço)') : t('Pausar (Espaço)')}
                  onClick={onPlayToggle}
                  className="hidden sm:inline-flex flex-none w-9 h-9 @[980px]:w-11 @[980px]:h-11 rounded-[10px] items-center justify-center bg-lu-accent text-lu-bg hover:bg-lu-accent-hover transition-colors"
                >
                  {paused ? <Play size={18} /> : <Pause size={18} />}
                </button>
                <SeekButtons currentTime={currentTime} duration={duration} onSeek={onSeek} />
                {onNext && (
                  <IconButton
                    id="btn-next-in-queue"
                    label={hasNext ? t('Próximo da fila') : t('Nenhum vídeo na fila')}
                    size={36}
                    disabled={!hasNext}
                    onClick={onNext}
                    className="!w-8 !h-8 @[880px]:!w-9 @[880px]:!h-9 @[1060px]:!w-11 @[1060px]:!h-11"
                  >
                    <SkipForward size={18} />
                  </IconButton>
                )}
              </>
            )}

            <span id="player-time-display" className="px-1.5 text-[12px] @[980px]:text-[13px] tabular text-lu-muted whitespace-nowrap flex-none">
              <span className="text-lu-text font-medium">{formatTime(currentTime)}</span> / {formatTime(duration)}
            </span>

            {showBuffer && (
              <span
                id="player-buffer-status"
                title={t('Buffer contíguo à frente: +{v1} s (até {v2})', { v1: bufferAhead.toFixed(1), v2: formatTime(currentTime + bufferAhead) })}
                className="hidden @[1040px]:inline-flex items-center gap-1.5 text-[12px] text-lu-muted whitespace-nowrap tabular flex-none"
              >
                <Dot tone={bufferTone} />
                {bufferAhead > 0.2 ? t('Buffer +{n} s', { n: bufferAhead.toFixed(1).replace('.', ',') }) : t('Buffer: baixando…')}
              </span>
            )}
          </div>

          <div className="flex items-center gap-0.5 @[980px]:gap-1 flex-nowrap justify-end flex-none">
            <VolumeDisplay volume={volume} muted={muted} onVolumeChange={onVolumeChange} onMuteToggle={onMuteToggle} />

            {/* Legendas */}
            <div className="relative" ref={subMenuRef}>
              <IconButton
                id="btn-subtitles-toggle"
                label={t('Legendas (C)')}
                aria-expanded={openMenu === 'subs'}
                onClick={() => toggleMenu('subs')}
                className={cx(
                  '!w-8 !h-8 @[880px]:!w-9 @[880px]:!h-9 @[1060px]:!w-11 @[1060px]:!h-11',
                  openMenu === 'subs' && 'bg-white/10',
                  (Boolean(activeSubtitle) || openMenu === 'subs') && '!text-lu-accent'
                )}
              >
                <Captions size={18} />
              </IconButton>
              {openMenu === 'subs' && (
                <MenuPanel
                  id="subtitles-popover-menu"
                  title={t('Legendas')}
                  meta={`${subtitles.length} ${subtitles.length === 1 ? 'faixa' : 'faixas'}`}
                  onClose={closeMenu}
                  className="right-0 w-[368px]"
                >
                  <div role="radiogroup" aria-label={t('Faixa de legenda')} className="flex flex-col gap-0.5">
                    <MenuItem
                      selected={activeSubtitle === null}
                      onClick={() => {
                        onSubtitleChange(null);
                        closeMenu();
                      }}
                      label={t('Desativadas')}
                    />
                    {subtitles.map((track) => (
                      <MenuItem
                        key={track.src}
                        selected={activeSubtitle?.src === track.src}
                        onClick={() => {
                          onSubtitleChange(track);
                          closeMenu();
                        }}
                        label={track.label}
                        hint={getSubtitleTag(track)}
                      />
                    ))}
                  </div>

                  {activeSubtitle && onSubtitleDelayChange && (
                    <>
                      <MenuDivider />
                      <MenuSection title={t('Sincronia')} value={formatMs(subtitleDelay)}>
                        <Slider
                          id="slider-subtitle-delay"
                          min="-5"
                          max="5"
                          step="0.05"
                          value={Math.max(-5, Math.min(5, subtitleDelay))}
                          aria-label={t('Sincronia')}
                          onChange={(e) => onSubtitleDelayChange(parseFloat(e.target.value))}
                        />
                        <ChipRow gap="tight">
                          <Chip dense className="!flex-auto px-2" onClick={() => onSubtitleDelayChange(Number((subtitleDelay - 0.25).toFixed(2)))}>−250 ms</Chip>
                          <Chip dense className="!flex-auto px-2" onClick={() => onSubtitleDelayChange(Number((subtitleDelay - 0.05).toFixed(2)))}>{t('−50 ms')}</Chip>
                          <Chip dense className="!flex-auto px-2" selected={subtitleDelay === 0} onClick={() => onSubtitleDelayChange(0)}>
                            {t('Redefinir')}
                          </Chip>
                          <Chip dense className="!flex-auto px-2" onClick={() => onSubtitleDelayChange(Number((subtitleDelay + 0.05).toFixed(2)))}>{t('+50 ms')}</Chip>
                          <Chip dense className="!flex-auto px-2" onClick={() => onSubtitleDelayChange(Number((subtitleDelay + 0.25).toFixed(2)))}>+250 ms</Chip>
                        </ChipRow>
                      </MenuSection>
                    </>
                  )}

                  {activeSubtitle && onSubtitleFontSizeChange && (
                    <>
                      <MenuDivider />
                      <MenuSection title={t('Tamanho da fonte')} value={`${subtitleFontSize}%`}>
                        <ChipRow gap="tight">
                          {[75, 100, 125, 150, 175].map((sz) => (
                            <Chip key={sz} dense selected={subtitleFontSize === sz} onClick={() => onSubtitleFontSizeChange(sz)}>
                              {sz}%
                            </Chip>
                          ))}
                        </ChipRow>
                      </MenuSection>
                    </>
                  )}

                  {activeSubtitle && onSubtitleBottomOffsetChange && (
                    <>
                      <MenuDivider />
                      <MenuSection title={t('Altura da legenda')} value={`${subtitleBottomOffset}%`} last={!onAddSubtitle}>
                        <ChipRow gap="tight">
                          {[0, 5, 10, 15, 20].map((off) => (
                            <Chip key={off} dense selected={subtitleBottomOffset === off} onClick={() => onSubtitleBottomOffsetChange(off)}>
                              {off}%
                            </Chip>
                          ))}
                        </ChipRow>
                      </MenuSection>
                    </>
                  )}

                  {onAddSubtitle && (
                    <>
                      <MenuDivider />
                      <button
                        type="button"
                        onClick={() => {
                          closeMenu();
                          onAddSubtitle();
                        }}
                        className="w-full inline-flex items-center gap-2 h-10 px-2.5 rounded-[10px] text-[14px] font-medium text-lu-accent hover:bg-white/6"
                      >
                        <Plus size={18} />
                        {t('Adicionar legenda')}
                      </button>
                    </>
                  )}
                </MenuPanel>
              )}
            </div>

            {/* Faixas de áudio */}
            {audioTracks.length > 0 && (
              <div className="relative hidden sm:block" ref={audioMenuRef}>
                <IconButton
                  id="btn-audio-tracks-toggle"
                  label={t('Faixas de áudio')}
                  aria-expanded={openMenu === 'audio'}
                  active={openMenu === 'audio'}
                  onClick={() => toggleMenu('audio')}
                  className="!w-8 !h-8 @[880px]:!w-9 @[880px]:!h-9 @[1060px]:!w-11 @[1060px]:!h-11"
                >
                  <AudioWaveform size={18} />
                </IconButton>
                {openMenu === 'audio' && (
                  <MenuPanel
                    id="audio-tracks-popover-menu"
                    title={t('Faixas de áudio')}
                    meta={`${audioTracks.length} ${audioTracks.length === 1 ? 'faixa' : 'faixas'}`}
                    onClose={closeMenu}
                    className="right-0 w-[320px]"
                  >
                    <div role="radiogroup" aria-label={t('Faixa de áudio')} className="flex flex-col gap-0.5 pb-1">
                      {audioTracks.map((trk) => (
                        <MenuItem
                          key={trk.id}
                          selected={activeAudioTrack?.id === trk.id}
                          onClick={() => {
                            onAudioTrackChange(trk);
                            closeMenu();
                          }}
                          label={trk.label}
                          hint={getAudioTag(trk)}
                        />
                      ))}
                    </div>
                  </MenuPanel>
                )}
              </div>
            )}

            {seriesContext && onSelectEpisodeStream && (
              <div ref={episodesToggleRef} className="hidden sm:inline-flex">
                <IconButton
                  id="btn-episodes-menu-toggle"
                  label={t('Episódios')}
                  aria-expanded={openMenu === 'episodes'}
                  active={openMenu === 'episodes'}
                  onClick={() => toggleMenu('episodes')}
                  className="!w-8 !h-8 @[880px]:!w-9 @[880px]:!h-9 @[1060px]:!w-11 @[1060px]:!h-11"
                >
                  <ListVideo size={18} />
                </IconButton>
              </div>
            )}

            <SettingsMenu
              playbackRate={playbackRate}
              onPlaybackRateChange={onPlaybackRateChange}
              volumeBoost={volumeBoost}
              onVolumeBoostChange={onVolumeBoostChange}
              qualities={qualities}
              autoQuality={autoQuality}
              onQualitySelect={onQualitySelect}
              autoSkipIntro={autoSkipIntro}
              onAutoSkipIntroChange={isViewer ? undefined : onAutoSkipIntroChange}
              audioDelay={audioDelay}
              onAudioDelayChange={onAudioDelayChange}
              subtitleDelay={subtitleDelay}
              onSubtitleDelayChange={onSubtitleDelayChange}
              subtitleFontSize={subtitleFontSize}
              onSubtitleFontSizeChange={onSubtitleFontSizeChange}
              canChangeRate={!isViewer}
              open={openMenu === 'settings'}
              onOpenChange={(o) => setOpenMenu(o ? 'settings' : null)}
            />

            {canPip && (
              <IconButton
                id="btn-pip-toggle"
                label={t('Picture-in-Picture')}
                onClick={onPipToggle}
                className={cx('hidden md:inline-flex !w-8 !h-8 @[880px]:!w-9 @[880px]:!h-9 @[1060px]:!w-11 @[1060px]:!h-11', isPip && '!text-lu-accent')}
              >
                <PictureInPicture2 size={18} />
              </IconButton>
            )}

            {onToggleAspect && (
              <IconButton
                id="btn-aspect-toggle"
                label={t(ASPECT_LABEL[aspectMode])}
                onClick={onToggleAspect}
                className={cx('hidden md:inline-flex !w-8 !h-8 @[880px]:!w-9 @[880px]:!h-9 @[1060px]:!w-11 @[1060px]:!h-11', aspectMode !== 'fit' && '!text-lu-accent')}
              >
                <Maximize2 size={18} />
              </IconButton>
            )}

            <IconButton
              id="btn-fullscreen-toggle"
              label={isFullscreen ? t('Sair da tela cheia (F)') : t('Tela cheia (F)')}
              onClick={onFullscreenToggle}
              className="!w-8 !h-8 @[880px]:!w-9 @[880px]:!h-9 @[1060px]:!w-11 @[1060px]:!h-11"
            >
              {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
};
