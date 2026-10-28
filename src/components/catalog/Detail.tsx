import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, Check, CheckCheck, ChevronLeft, Film, History, Play, Tv, Users, X } from 'lucide-react';
import {
  CatalogEpisode,
  CatalogItem,
  CatalogMeta,
  GENRES_PT,
  episodeTag,
  fetchMalScore,
  fetchMeta,
  isInMyList,
  isSeriesType,
  seasonOrder,
  toggleMyList,
  useWatchedEpisodes,
} from '../../lib/catalog';
import { GhostButton, PillTabs, PrimaryButton, Spinner, TextButton, cx } from '../ui';
import { t } from '../../lib/i18n';
import { writeSeasonToUrl } from '../../lib/searchUrl';
import { ImdbIcon, MalIcon } from './BrandIcons';
import { StreamList } from './StreamList';
import { type VideoAddon } from '../../lib/addons';
import type { StreamOption } from '../../lib/streams';
import type { CatalogSeriesContext } from '../../types/media';
import { CHANGE_EVENT as CONTINUE_CHANGE_EVENT, removeContinue, resumePositionFor, type CatalogRef } from '../../lib/continueWatching';
import { formatTime } from '../../lib/chapters';
import { discordManager } from '../../lib/discord';
import type { WatchIntent } from './types';
import { Poster, gradientFor } from './Poster';
import { BrandBadge } from './BrandBadge';

interface DetailProps {
  item: CatalogItem;
  initialSeason?: number | null;
  /** Episódio aberto (o `videos[].id` do meta); o endereço é do CatalogTab. */
  episodeId: string | null;
  onEpisodeChange: (id: string | null) => void;
  addons: VideoAddon[];
  onOpenAddons: () => void;
  onBack: () => void;
  onWatch: (intent: WatchIntent) => void;
  /** Filme: sem contexto de série, mas com o título (para o "continuar assistindo"). */
  onPlayStream: (stream: StreamOption, title: string, seriesContext?: CatalogSeriesContext, movie?: CatalogRef) => void;
}

/** Nota do MyAnimeList com novas tentativas (a API pode estar fria ou limitando). `null`: sem nota, desistiu ou foi cancelado. */
async function fetchMalScoreRetrying(malId: string, cancelled: () => boolean): Promise<{ score: number; rank?: number } | null> {
  for (const wait of [0, 5000, 15000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (cancelled()) return null;
    try {
      const r = await fetchMalScore(malId);
      if (cancelled()) return null;
      if (r.score !== null) return { score: r.score, rank: r.rank };
      if (!r.failed) return null; // sem nota (ainda sem votos): não adianta insistir
    } catch {
      // tenta de novo
    }
  }
  return null;
}

export const Detail: React.FC<DetailProps> = ({ item, initialSeason = null, episodeId, onEpisodeChange, addons, onOpenAddons, onBack, onWatch, onPlayStream }) => {
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const [error, setError] = useState(false);
  const [season, setSeason] = useState<number>(initialSeason ?? 1);
  /** Notas do MyAnimeList já conhecidas, por id do MAL (a série e cada temporada que tem o seu). */
  const [malScores, setMalScores] = useState<Record<string, { score: number; rank?: number }>>({});
  const [saved, setSaved] = useState(() => isInMyList(item.id));
  const { isWatched, toggleWatched, setEpisodesWatched } = useWatchedEpisodes();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; episode: CatalogEpisode } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const onDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    const onScroll = () => {
      setContextMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    // Resposta de um título anterior não pode mexer no atual
    let cancelled = false;
    setMeta(null);
    setError(false);
    fetchMeta(item.type, item.id)
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
        const order = seasonOrder(m.episodes.map((e) => e.season));
        // O episódio do endereço manda na temporada; senão vale a do endereço (se o título a tem); senão, a primeira
        const opened = episodeId ? m.episodes.find((e) => e.id === episodeId) : undefined;
        if (opened) setSeason(opened.season);
        else if (initialSeason !== null && order.includes(initialSeason)) setSeason(initialSeason);
        else if (order[0] !== undefined) setSeason(order[0]);
        // Episódio que o título não tem: volta à lista
        if (episodeId && !opened) onEpisodeChange(null);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [item]);

  // As notas que o servidor já tinha guardadas vêm junto do detalhe (as demais são pedidas abaixo, uma vez por id do MAL)
  useEffect(() => {
    if (!meta) return;
    setMalScores((prev) => {
      const next = { ...prev };
      if (meta.malId && meta.malScore !== undefined) next[meta.malId] = { score: meta.malScore, rank: meta.malRank };
      for (const s of Object.values(meta.seasonMalScores ?? {})) next[s.malId] = { score: s.score, rank: s.rank };
      return next;
    });
  }, [meta]);

  const data = meta ?? { ...item, genres: [], episodes: [] as CatalogMeta['episodes'], description: undefined, runtime: undefined, imdbRating: undefined, background: undefined };
  // 1, 2, 3… e os especiais (temporada 0) no fim
  const seasons = useMemo(() => seasonOrder(data.episodes.map((e) => e.season)), [data.episodes]);
  const episodes = data.episodes.filter((e) => e.season === season);
  const isSeries = isSeriesType(item.type);
  // A temporada aberta vai para o endereço (`?season=`) e sai dele ao fechar o título
  useEffect(() => {
    writeSeasonToUrl(isSeries && seasons.length > 0 ? season : null);
  }, [season, isSeries, seasons.length]);
  useEffect(() => () => writeSeasonToUrl(null), []);
  const firstEpisode = data.episodes.find((e) => e.season >= 1) ?? data.episodes[0];

  // Capa e nota correspondentes à temporada atualmente selecionada
  const currentSeasonStr = String(season);
  // Item `mal:` tem capa por temporada; o do IMDb mostra sempre a capa principal do catálogo
  const activePoster = item.id.startsWith('mal:')
    ? (isSeries && data.seasonPosters?.[currentSeasonStr]) || data.poster || item.poster
    : item.poster || data.poster;
  const currentMalId = (isSeries && data.seasonMalIds?.[currentSeasonStr]) || data.malId;
  const currentMalScore = (currentMalId && malScores[currentMalId]) || null;

  // Nota do MAL que ainda não se conhece: pedida à parte, com novas tentativas (o detalhe nunca espera por ela). Um pedido por id
  const hasCurrentScore = currentMalScore !== null;
  useEffect(() => {
    if (!currentMalId || hasCurrentScore) return;
    let cancelled = false;
    void fetchMalScoreRetrying(currentMalId, () => cancelled).then((r) => {
      if (r) setMalScores((prev) => ({ ...prev, [currentMalId]: r }));
    });
    return () => {
      cancelled = true;
    };
  }, [currentMalId, hasCurrentScore]);

  const watchTitle = (preferSolo: boolean) => {
    const title = isSeries && firstEpisode ? `${data.name} · ${episodeTag(firstEpisode.season, firstEpisode.episode)}` : data.name;
    onWatch({ title, preferSolo });
  };

  // "Onde assistir": filme direto no detalhe; série, no episódio aberto (`/detail/<tipo>/<id>/<videoId>`)
  const openEpisode = isSeries && episodeId ? data.episodes.find((e) => e.id === episodeId) : undefined;
  const episodeTitle = openEpisode ? `${data.name} · ${episodeTag(openEpisode.season, openEpisode.episode)}` : data.name;
  // "Continuar assistindo": o vídeo abre onde parou ao escolher o stream; avisa antes e deixa recomeçar do início
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const openEpisodeRef = openEpisode ? { videoId: openEpisode.id, season: openEpisode.season, episode: openEpisode.episode } : undefined;
  const openEpisodeKey = openEpisode?.id;
  useEffect(() => {
    const refresh = () => setResumeAt(resumePositionFor({ type: item.type, id: item.id, episode: openEpisodeRef }));
    refresh();
    window.addEventListener(CONTINUE_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(CONTINUE_CHANGE_EVENT, refresh);
    // `openEpisodeRef` é derivado de `openEpisodeKey`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.type, item.id, openEpisodeKey]);
  const resumeHint =
    resumeAt !== null && (!isSeries || openEpisode) ? (
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-lu-muted">
        <span className="inline-flex items-center gap-2">
          <History size={16} className="text-lu-accent" />
          {t('Retoma em {time}', { time: formatTime(resumeAt) })}
        </span>
        <TextButton tone="accent" size="sm" onClick={() => removeContinue({ type: item.type, id: item.id })}>
          {t('Recomeçar do início')}
        </TextButton>
      </p>
    ) : null;
  const streamsList = discordManager.isDiscordActivity() ? (
    // Dentro do Discord o iframe só fala com origens mapeadas: o navegador não alcança o addon
    <p className="m-0 text-[14px] text-lu-muted">{t('Os addons não estão disponíveis no Discord. Cole o link do vídeo.')}</p>
  ) : (
    <StreamList
      addons={addons}
      target={
        isSeries
          ? openEpisode
            ? { type: item.type === 'anime' ? 'anime' : 'series', videoId: openEpisode.id, seriesId: item.id, season: openEpisode.season, episode: openEpisode.episode }
            : null
          : { type: 'movie', videoId: item.id }
      }
      onPlay={(stream) => {
        const seriesContext: CatalogSeriesContext | undefined =
          isSeries && openEpisode
            ? {
                seriesId: item.id,
                seriesTitle: data.name,
                seriesType: item.type,
                seriesPoster: data.poster || item.poster,
                currentEpisodeId: openEpisode.id,
                season: openEpisode.season,
                episode: openEpisode.episode,
                episodes: data.episodes,
              }
            : undefined;
        onPlayStream(stream, episodeTitle, seriesContext, isSeries ? undefined : { type: item.type, id: item.id, name: data.name, poster: data.poster || item.poster });
      }}
      onOpenAddons={onOpenAddons}
    />
  );

  const metaLine = [
    data.year,
    isSeries && seasons.length
      ? `${seasons.filter((s) => s >= 1).length || seasons.length} ${(seasons.filter((s) => s >= 1).length || seasons.length) === 1 ? t('temporada') : t('temporadas')}`
      : data.runtime,
    data.genres.slice(0, 3).map((g) => t(GENRES_PT[g] || g)).join(', '),
  ].filter(Boolean);

  return (
    <div className="-mx-4 sm:-mx-12 -mt-6 flex flex-col">
      <section className="relative px-4 sm:px-12 pt-2 pb-10">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-[520px] pointer-events-none"
          style={{
            background:
              'radial-gradient(60% 80% at 75% 20%,rgba(124,58,237,0.28),transparent 70%),linear-gradient(180deg,rgba(42,34,80,0) 0%,rgba(42,34,80,0.45) 25%,rgba(8,10,15,0) 95%)',
          }}
        />
        {data.background && (
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-[520px] pointer-events-none opacity-25 bg-cover bg-center [mask-image:linear-gradient(180deg,black,transparent)]"
            style={{ backgroundImage: `url(${data.background})` }}
          />
        )}
        <div className="relative">
          <TextButton onClick={onBack} className="!pl-2 -ml-2">
            <ChevronLeft size={18} />
            <span>{t('Catálogo')}</span>
          </TextButton>
          <div className="flex flex-col sm:flex-row gap-6 sm:gap-10 mt-4 sm:items-end">
            <Poster item={{ ...data, poster: activePoster }} iconSize={48} className="w-[160px] sm:w-[240px] aspect-[2/3]" />
            <div className="flex-1 min-w-0 flex flex-col gap-3.5 sm:pb-2">
              <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-lu-tint text-lu-accent text-[12px] font-semibold self-start">
                {isSeries ? <Tv size={14} /> : <Film size={14} />}
                {isSeries ? t('Série') : t('Filme')}
              </span>
              <h1 className="m-0 text-[32px] sm:text-[48px] font-bold tracking-[-0.03em] leading-[1.05]">{data.name}</h1>
              {metaLine.length > 0 && (
                <p className="m-0 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[14px] text-lu-muted">
                  {metaLine.map((bit, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && <span aria-hidden="true">·</span>}
                      <span>{bit}</span>
                    </React.Fragment>
                  ))}
                  {(data.imdbRating || data.imdbId) && (
                    <BrandBadge
                      href={data.imdbId ? `https://www.imdb.com/title/${data.imdbId}/` : undefined}
                      label={data.imdbRating ? `${t('Nota do IMDb')}: ${data.imdbRating}` : t('Abrir no IMDb')}
                      icon={<ImdbIcon />}
                    >
                      {data.imdbRating ?? 'IMDb'}
                    </BrandBadge>
                  )}
                  {currentMalId && (
                    <BrandBadge
                      href={`https://myanimelist.net/anime/${currentMalId}`}
                      label={
                        currentMalScore
                          ? `${t('Nota do MyAnimeList')}: ${currentMalScore.score.toFixed(2)}${currentMalScore.rank ? ` · ${t('ranking')} #${currentMalScore.rank}` : ''}`
                          : t('Abrir no MyAnimeList')
                      }
                      icon={<MalIcon />}
                    >
                      {currentMalScore ? currentMalScore.score.toFixed(2) : 'MyAnimeList'}
                    </BrandBadge>
                  )}
                </p>
              )}
              {data.description ? (
                <p className="m-0 max-w-[680px] text-[15px] leading-relaxed text-lu-muted line-clamp-4">{data.description}</p>
              ) : !meta && !error ? (
                <span className="flex items-center gap-2 text-[14px] text-lu-muted">
                  <Spinner size={16} className="text-lu-accent" />
                  {t('Carregando detalhes…')}
                </span>
              ) : null}
              {error && <p className="m-0 text-[14px] text-lu-error">{t('Não deu pra carregar os detalhes desse título.')}</p>}
              <div className="flex flex-wrap gap-3 mt-2">
                <PrimaryButton size="lg" onClick={() => watchTitle(false)}>
                  <Users size={18} />
                  <span>{t('Assistir com amigos')}</span>
                </PrimaryButton>
                <GhostButton size="lg" onClick={() => watchTitle(true)}>
                  <Play size={16} />
                  <span>{t('Assistir sozinho')}</span>
                </GhostButton>
                <GhostButton
                  size="lg"
                  aria-label={saved ? t('Tirar da minha lista') : t('Salvar na lista')}
                  title={saved ? t('Tirar da minha lista') : t('Salvar na lista')}
                  aria-pressed={saved}
                  className={cx('!w-12 !px-0', saved && '!text-lu-accent')}
                  onClick={() => setSaved(toggleMyList(data))}
                >
                  {saved ? <BookmarkCheck size={18} /> : <Bookmark size={18} />}
                </GhostButton>
              </div>
            </div>
          </div>
        </div>
      </section>

      {!isSeries && !error && (
        <section className="px-4 sm:px-12 pt-2 flex flex-col gap-3">
          {!discordManager.isDiscordActivity() && resumeHint}
          {streamsList}
        </section>
      )}

      {isSeries && openEpisode && (
        <section aria-label={t('Onde assistir')} className="px-4 sm:px-12 pt-2 flex flex-col gap-4">
          <div
            className="flex flex-wrap items-center gap-3 cursor-context-menu"
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({ x: e.clientX, y: e.clientY, episode: openEpisode });
            }}
          >
            <TextButton onClick={() => onEpisodeChange(null)} className="!pl-2 -ml-2">
              <ChevronLeft size={18} />
              <span>{t('Episódios')}</span>
            </TextButton>
            <h2 className="m-0 text-[18px] font-semibold flex items-center gap-2">
              <span>
                {episodeTag(openEpisode.season, openEpisode.episode)} · {openEpisode.title || t('Episódio {v1}', { v1: openEpisode.episode })}
              </span>
              {isWatched(openEpisode.id) && (
                <span
                  title={t('Assistido')}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[13px] font-semibold bg-lu-tint text-lu-accent border border-lu-accent/40 shadow-sm"
                >
                  <Check size={14} strokeWidth={2.5} />
                  <span>{t('Assistido')}</span>
                </span>
              )}
            </h2>
          </div>
          {!discordManager.isDiscordActivity() && resumeHint}
          {streamsList}
          <GhostButton className="self-start" onClick={() => onWatch({ title: episodeTitle, preferSolo: false })}>
            {t('Colar o link do vídeo')}
          </GhostButton>
        </section>
      )}

      {isSeries && !openEpisode && seasons.length > 0 && (
        <section aria-label={t('Episódios')} className="px-4 sm:px-12 pt-2 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="m-0 text-[18px] font-semibold">{t('Episódios')}</h2>
              {episodes.length > 0 && (
                <TextButton
                  size="sm"
                  onClick={() => {
                    const allWatched = episodes.every((ep) => isWatched(ep.id));
                    setEpisodesWatched(episodes.map((ep) => ep.id), !allWatched);
                  }}
                  className="text-[13px]"
                >
                  <CheckCheck
                    size={16}
                    className={episodes.every((ep) => isWatched(ep.id)) ? 'text-lu-accent' : 'text-lu-muted'}
                  />
                  <span>
                    {episodes.every((ep) => isWatched(ep.id))
                      ? t('Marcar temporada como não assistida')
                      : t('Marcar temporada como assistida')}
                  </span>
                </TextButton>
              )}
            </div>
            <div className="max-w-full overflow-x-auto no-scrollbar">
              <PillTabs
                label={t('Temporadas')}
                size="sm"
                value={String(season)}
                onChange={(v) => setSeason(Number(v))}
                options={seasons.map((s) => ({ value: String(s), label: s === 0 ? t('Especiais') : t('Temporada {s}', { s }) }))}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {episodes.map((ep) => {
              const watched = isWatched(ep.id);
              return (
                <button
                  key={ep.id}
                  type="button"
                  onClick={() => onEpisodeChange(ep.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({ x: e.clientX, y: e.clientY, episode: ep });
                  }}
                  className={cx(
                    'group flex items-start gap-4 p-3 rounded-[14px] bg-lu-bg2 border border-lu-border hover:bg-white/6 text-left w-full transition-colors',
                    watched && 'border-lu-border-strong',
                  )}
                >
                  <span
                    className="relative w-[128px] sm:w-[176px] aspect-video flex-none rounded-[10px] overflow-hidden flex items-center justify-center"
                    style={{ background: gradientFor(ep.id) }}
                  >
                    {ep.thumbnail && (
                      <img
                        src={ep.thumbnail}
                        alt=""
                        loading="lazy"
                        className={cx('absolute inset-0 w-full h-full object-cover', watched && 'opacity-85')}
                        onError={(e) => (e.currentTarget.style.display = 'none')}
                      />
                    )}
                    {watched && (
                      <span
                        title={t('Assistido')}
                        className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-lu-bg/95 border border-lu-accent/60 text-lu-accent text-[12px] font-semibold shadow-lg backdrop-blur-sm"
                      >
                        <Check size={14} strokeWidth={2.5} />
                        <span>{t('Assistido')}</span>
                      </span>
                    )}
                    <span className="relative opacity-0 group-hover:opacity-100 transition-opacity w-10 h-10 rounded-full bg-lu-video/70 flex items-center justify-center">
                      <Play size={18} />
                    </span>
                  </span>
                  <span className="flex flex-col gap-1 min-w-0">
                    <span className="text-[14px] font-semibold">
                      {ep.episode}. {ep.title || t('Episódio {v1}', { v1: ep.episode })}
                    </span>
                    <span className="text-[12px] text-lu-muted flex items-center gap-1.5 flex-wrap">
                      <span>{episodeTag(ep.season, ep.episode)}</span>
                      {watched && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1 text-lu-accent text-[12px] font-semibold">
                            <Check size={13} strokeWidth={2.5} />
                            {t('Assistido')}
                          </span>
                        </>
                      )}
                      {ep.released && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{new Date(ep.released).toLocaleDateString('pt-BR')}</span>
                        </>
                      )}
                    </span>
                    {ep.overview && <span className="text-[13px] leading-snug text-lu-muted line-clamp-2">{ep.overview}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          style={{
            position: 'fixed',
            left: Math.max(12, Math.min(contextMenu.x, window.innerWidth - 220 - 12)),
            top: Math.max(12, Math.min(contextMenu.y, window.innerHeight - 56 - 12)),
          }}
          className="z-50 min-w-[210px] p-1.5 rounded-[12px] bg-lu-elevated border border-lu-border shadow-[0_16px_40px_rgba(0,0,0,0.6)] text-lu-text backdrop-blur-md"
          onClick={(e) => e.stopPropagation()}
          role="menu"
          aria-label={t('Opções do episódio')}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              toggleWatched(contextMenu.episode.id);
              setContextMenu(null);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[8px] text-[13px] font-medium text-left transition-colors hover:bg-white/8 hover:text-lu-text cursor-pointer text-lu-text"
          >
            {isWatched(contextMenu.episode.id) ? (
              <>
                <X size={15} className="text-lu-muted flex-none" />
                <span>{t('Marcar como não assistido')}</span>
              </>
            ) : (
              <>
                <Check size={15} className="text-lu-accent flex-none" />
                <span>{t('Marcar como assistido')}</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};
