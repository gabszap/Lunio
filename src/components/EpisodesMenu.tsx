import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Play, Check, AlertCircle, X } from 'lucide-react';
import type { CatalogEpisode } from '../lib/catalog';
import { episodeTag, seasonOrder, useWatchedEpisodes } from '../lib/catalog';
import type { CatalogSeriesContext } from '../types/media';
import { loadAddons, type VideoAddon } from '../lib/addons';
import type { StreamOption, StreamTarget } from '../lib/streams';
import { useStreams } from './catalog/useStreams';
import { Badge, IconButton, Spinner, cx, useDismiss } from './ui';
import { t } from '../lib/i18n';

interface EpisodesOverlayProps {
  seriesContext: CatalogSeriesContext;
  open: boolean;
  onClose: () => void;
  onSelectEpisodeStream: (episode: CatalogEpisode, stream: StreamOption) => void;
  isViewer?: boolean;
}

const BADGE_TONE: Record<'ok' | 'maybe' | 'no', string> = {
  ok: 'text-lu-text',
  maybe: 'text-lu-muted',
  no: 'text-lu-muted opacity-70',
};

export const EpisodesOverlay: React.FC<EpisodesOverlayProps> = ({
  seriesContext,
  open,
  onClose,
  onSelectEpisodeStream,
  isViewer = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  useDismiss(open, onClose, containerRef);

  const [selectedSeason, setSelectedSeason] = useState<number>(seriesContext.season || 1);
  const [targetEpisode, setTargetEpisode] = useState<CatalogEpisode | null>(null);
  const [addons, setAddons] = useState<VideoAddon[]>([]);
  const { isWatched } = useWatchedEpisodes();

  // Carrega os addons ao abrir
  useEffect(() => {
    if (open) {
      setAddons(loadAddons());
    } else {
      setTargetEpisode(null);
    }
  }, [open]);

  // Sincroniza temporada ativa com o episódio em reprodução
  useEffect(() => {
    if (seriesContext.season) {
      setSelectedSeason(seriesContext.season);
    }
  }, [seriesContext.season, seriesContext.currentEpisodeId]);

  const seasons = useMemo(
    () => seasonOrder(seriesContext.episodes.map((e) => e.season)),
    [seriesContext.episodes],
  );

  const seasonEpisodes = useMemo(
    () => seriesContext.episodes.filter((e) => e.season === selectedSeason),
    [seriesContext.episodes, selectedSeason],
  );

  const streamTarget: StreamTarget | null = useMemo(() => {
    if (!targetEpisode) return null;
    return {
      type: seriesContext.seriesType === 'anime' ? 'anime' : 'series',
      videoId: targetEpisode.id,
      seriesId: seriesContext.seriesId,
      season: targetEpisode.season,
      episode: targetEpisode.episode,
    };
  }, [targetEpisode, seriesContext]);

  const { state: streamsState } = useStreams(addons, streamTarget);

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      id="player-episodes-overlay"
      className={cx(
        'absolute left-3 sm:left-6 top-14 sm:top-16 bottom-20 sm:bottom-24 z-40',
        targetEpisode ? 'w-[440px] sm:w-[560px]' : 'w-[360px] sm:w-[420px]',
        'max-w-[calc(100vw-24px)] transition-all duration-200',
        'rounded-[20px] bg-lu-surface/95 border border-lu-border shadow-[0_20px_50px_rgba(0,0,0,0.85)]',
        'backdrop-blur-xl p-4 flex flex-col gap-3 pointer-events-auto select-none overflow-hidden',
      )}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* Cabeçalho */}
      <div className="flex items-center justify-between pb-1 flex-none border-b border-lu-border">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[17px] font-bold text-lu-text tracking-tight truncate">
            {targetEpisode
              ? `${episodeTag(targetEpisode.season, targetEpisode.episode)} · ${targetEpisode.title || t('Episódio {v1}', { v1: targetEpisode.episode })}`
              : t('Episódios')}
          </h3>
          <p className="m-0 text-[12px] text-lu-muted truncate">
            {targetEpisode ? t('Escolha uma fonte para assistir') : seriesContext.seriesTitle}
          </p>
        </div>
        <IconButton size={36} label={t('Fechar')} onClick={onClose} tone="muted">
          <X size={18} />
        </IconButton>
      </div>

      {targetEpisode ? (
        // Visão 2: Fontes do episódio selecionado (com expansão dinâmica para 560px e texto completo legível)
        <div className="flex-1 flex flex-col gap-2 min-h-0 overflow-hidden">
          <button
            type="button"
            onClick={() => setTargetEpisode(null)}
            className="self-start inline-flex items-center gap-1.5 px-2 py-1 -ml-1 text-[13px] font-medium text-lu-muted hover:text-lu-text rounded-md transition-colors cursor-pointer"
          >
            <ChevronLeft size={16} />
            <span>{t('Voltar aos episódios')}</span>
          </button>

          {streamsState.status === 'loading' && (
            <div className="flex-1 flex flex-col items-center justify-center py-8 gap-2">
              <Spinner size={24} className="text-lu-accent" />
              <span className="text-[13px] text-lu-muted">{t('Buscando streams…')}</span>
            </div>
          )}

          {streamsState.status === 'done' && streamsState.options.length === 0 && (
            <div className="flex-1 flex items-center justify-center">
              <p className="m-0 text-center text-[13px] text-lu-muted py-6">
                {t('Nenhum stream encontrado')}
              </p>
            </div>
          )}

          {streamsState.options.length > 0 && (
            <div className="flex-1 flex flex-col gap-2.5 overflow-y-auto overflow-x-hidden custom-scrollbar pr-1">
              {streamsState.options.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  title={option.description ? `${option.title}\n\n${option.description}` : option.title}
                  onClick={() => {
                    onSelectEpisodeStream(targetEpisode, option);
                    onClose();
                    setTargetEpisode(null);
                  }}
                  className={cx(
                    'w-full flex items-start justify-between gap-3 p-3 rounded-[14px] bg-lu-bg border border-lu-border text-left cursor-pointer transition-all',
                    'hover:bg-white/8 hover:border-lu-border-strong text-lu-text group',
                    option.level === 'no' && 'opacity-70',
                  )}
                >
                  <span className="flex flex-col min-w-0 flex-1 gap-1">
                    <span className="text-[11px] text-lu-muted truncate">{option.sourceName}</span>
                    {option.title && (
                      <span className="text-[13px] font-semibold whitespace-pre-line break-words text-lu-text group-hover:text-lu-accent-hover transition-colors">
                        {option.title}
                      </span>
                    )}
                    {option.description && (
                      <span className="text-[12px] leading-relaxed text-lu-muted whitespace-pre-line break-words">
                        {option.description}
                      </span>
                    )}
                  </span>
                  <Badge className={cx('flex-none text-[11px] px-2 py-0.5', BADGE_TONE[option.level])}>
                    <span>
                      {option.level === 'ok' ? t('Toca') : option.level === 'maybe' ? t('Pode falhar') : t('Não toca')}
                    </span>
                  </Badge>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        // Visão 1: Seletor de temporadas em bolas com 'S' + Lista de episódios com thumb fixa 112x63 sem esticar
        <div className="flex-1 flex flex-col gap-3 min-h-0 overflow-hidden">
          {isViewer && (
            <div className="flex items-center gap-2 p-2 rounded-lg bg-lu-tint/50 text-[12px] text-lu-accent flex-none">
              <AlertCircle size={15} className="flex-none" />
              <span>{t('Apenas o Host pode trocar o episódio da sala')}</span>
            </div>
          )}

          {/* Bolinhas das temporadas: S1 S2 S3... */}
          {seasons.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1 flex-none">
              {seasons.map((s) => {
                const isSelected = s === selectedSeason;
                const label = s === 0 ? 'S0' : `S${s}`;
                const fullLabel = s === 0 ? t('Especiais') : t('Temporada {s}', { s });
                return (
                  <button
                    key={s}
                    type="button"
                    title={fullLabel}
                    aria-label={fullLabel}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedSeason(s)}
                    className={cx(
                      'min-w-[42px] h-9 px-2 rounded-full flex items-center justify-center font-bold text-[13px] transition-all cursor-pointer flex-none',
                      isSelected
                        ? 'bg-lu-accent text-lu-bg shadow-md scale-105'
                        : 'bg-white/6 hover:bg-white/12 text-lu-muted hover:text-lu-text border border-white/5',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Lista de episódios: Thumb fixa (112x63) + Número + Nome + Data */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar flex flex-col gap-2 pr-1 min-h-0">
            {seasonEpisodes.map((ep) => {
              const isCurrent = ep.id === seriesContext.currentEpisodeId;
              const watched = isWatched(ep.id);
              return (
                <div
                  key={ep.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (isViewer) return;
                    setTargetEpisode(ep);
                  }}
                  onKeyDown={(e) => {
                    if (isViewer) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setTargetEpisode(ep);
                    }
                  }}
                  className={cx(
                    'w-full flex items-center gap-3 p-2 rounded-[14px] text-left transition-all cursor-pointer group select-none',
                    isCurrent
                      ? 'bg-lu-tint/70 border border-lu-accent/40 text-lu-text'
                      : 'bg-white/[0.03] hover:bg-white/8 text-lu-text border border-white/5',
                  )}
                >
                  {/* Thumbnail do episódio com dimensões travadas (112x63) para nunca bugar em tela cheia */}
                  <div className="relative w-28 h-[63px] min-w-[112px] max-w-[112px] min-h-[63px] max-h-[63px] shrink-0 rounded-[8px] overflow-hidden bg-lu-bg border border-white/10">
                    {ep.thumbnail ? (
                      <img
                        src={ep.thumbnail}
                        alt=""
                        loading="lazy"
                        className={cx('w-full h-full object-cover block transition-opacity', isCurrent && 'brightness-75')}
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-lu-bg text-lu-disabled font-bold text-[11px]">
                        {episodeTag(ep.season, ep.episode)}
                      </div>
                    )}

                    {isCurrent ? (
                      <span className="absolute inset-0 bg-lu-video/40 flex items-center justify-center pointer-events-none">
                        <span className="flex items-center gap-1 text-[10px] font-bold text-white bg-lu-accent/90 px-1.5 py-0.5 rounded-full shadow">
                          <Play size={9} className="fill-current" />
                          <span>{t('Tocando')}</span>
                        </span>
                      </span>
                    ) : watched ? (
                      <span
                        title={t('Assistido')}
                        className="absolute top-1 right-1 z-10 flex items-center justify-center w-5 h-5 rounded-full bg-lu-bg/90 border border-lu-accent/50 text-lu-accent shadow pointer-events-none"
                      >
                        <Check size={12} strokeWidth={2.5} />
                      </span>
                    ) : null}
                  </div>

                  {/* Informações: Número, título e data */}
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1 overflow-hidden justify-center">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[13px] font-bold text-lu-accent shrink-0">
                        {ep.episode}.
                      </span>
                      <span className="text-[13px] font-semibold truncate text-lu-text group-hover:text-lu-accent-hover transition-colors">
                        {ep.title || t('Episódio {v1}', { v1: ep.episode })}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-[11px] text-lu-muted truncate">
                      <span>{episodeTag(ep.season, ep.episode)}</span>
                      {ep.released && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{new Date(ep.released).toLocaleDateString('pt-BR')}</span>
                        </>
                      )}
                      {watched && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-lu-accent font-medium">{t('Assistido')}</span>
                        </>
                      )}
                    </div>

                    {ep.overview && (
                      <p className="m-0 text-[11px] text-lu-muted truncate leading-tight mt-0.5">
                        {ep.overview}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
