import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, Check, CheckCheck, ChevronLeft, ChevronRight, Film, Play, Puzzle, Search, SearchX, Star, Tv, Users, X, RefreshCw } from 'lucide-react';
import {
  CatalogEpisode,
  CatalogItem,
  CatalogManifest,
  CatalogMeta,
  CatalogRow,
  GENRES_PT,
  SearchGroup,
  episodeTag,
  fetchMalScore,
  fetchManifest,
  fetchMeta,
  fetchRow,
  getMyList,
  isInMyList,
  isSeriesType,
  mergeGroups,
  rowTitles,
  searchCatalog,
  seasonOrder,
  toggleMyList,
  useWatchedEpisodes,
} from '../../lib/catalog';
import { GhostButton, IconButton, PillTabs, PrimaryButton, Spinner, TextButton, cx } from '../ui';
import { t } from '../../lib/i18n';
import { DetailRef, writeDetailToUrl, writeSearchToUrl, writeSeasonToUrl } from '../../lib/searchUrl';
import { ImdbIcon, MalIcon } from './BrandIcons';
import { AddonsPanel } from './AddonsPanel';
import { StreamList } from './StreamList';
import { loadAddons, type VideoAddon } from '../../lib/addons';
import type { StreamOption } from '../../lib/streams';
import type { CatalogSeriesContext } from '../../types/media';
import { discordManager } from '../../lib/discord';

export interface WatchIntent {
  title: string;
  preferSolo: boolean;
}

interface CatalogTabProps {
  /** Busca e título vindos do endereço (`?search=`, `?detail=`). */
  initialQuery?: string;
  initialDetail?: DetailRef | null;
  /** Temporada do título aberto pelo endereço (`?season=`). */
  initialSeason?: number | null;
  onWatch: (intent: WatchIntent) => void;
  /** Um stream escolhido na lista "Onde assistir" (o App cria a sala e abre o player). */
  onPlayStream: (stream: StreamOption, title: string, seriesContext?: CatalogSeriesContext) => void;
  onCreateRoom: () => void;
}

const PLACEHOLDER_GRADIENTS = [
  'linear-gradient(160deg,#2A2250,#14172B)',
  'linear-gradient(160deg,#1B2F4A,#101826)',
  'linear-gradient(160deg,#3A2260,#171230)',
  'linear-gradient(160deg,#173A47,#0E1A24)',
  'linear-gradient(160deg,#2E2A57,#12132A)',
  'linear-gradient(160deg,#40305E,#1A1328)',
];

const gradientFor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PLACEHOLDER_GRADIENTS[h % PLACEHOLDER_GRADIENTS.length];
};

// ───────────────────────── Pôster ─────────────────────────

const Poster: React.FC<{ item: CatalogItem; className?: string; iconSize?: number }> = ({ item, className, iconSize = 32 }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [item.poster]);
  return (
    <span
      className={cx('relative flex-none rounded-xl border border-lu-border overflow-hidden flex items-center justify-center text-lu-text/35', className)}
      style={{ background: gradientFor(item.id) }}
    >
      {item.poster && !failed ? (
        <img key={item.poster} src={item.poster} alt="" loading="lazy" onError={() => setFailed(true)} className="absolute inset-0 w-full h-full object-cover transition-opacity duration-300" />
      ) : (
        <Film size={iconSize} />
      )}
    </span>
  );
};

const PosterCard: React.FC<{ item: CatalogItem; onOpen: (item: CatalogItem) => void; showType?: boolean; fluid?: boolean }> = ({
  item,
  onOpen,
  showType,
  fluid,
}) => (
  <button
    type="button"
    onClick={() => onOpen(item)}
    className={cx('group flex flex-col items-start gap-2 text-left rounded-xl flex-none', fluid ? 'w-full' : 'w-[128px] sm:w-[152px]')}
  >
    <Poster item={item} className="w-full aspect-[2/3] transition-transform group-hover:-translate-y-0.5" />
    <span className="flex flex-col min-w-0 w-full">
      <span className="text-[13px] font-semibold text-lu-text truncate">{item.name}</span>
      <span className="text-[12px] text-lu-muted">
        {showType ? `${isSeriesType(item.type) ? t('Série') : t('Filme')}${item.year ? ` · ${item.year}` : ''}` : item.year || ' '}
      </span>
    </span>
  </button>
);

// ───────────────────────── Fileira com rolagem ─────────────────────────

const Row: React.FC<{
  title: string;
  load: () => Promise<CatalogItem[]>;
  onOpen: (item: CatalogItem) => void;
  items?: CatalogItem[];
  /** Só pede os itens quando a fileira chega perto da tela (uma fonte pode ter dezenas de fileiras). */
  lazy?: boolean;
}> = ({ title, load, onOpen, items: fixedItems, lazy = false }) => {
  const [items, setItems] = useState<CatalogItem[] | null>(fixedItems ?? null);
  const [error, setError] = useState(false);
  const [visible, setVisible] = useState(!lazy);
  const scroller = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (visible) return;
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '400px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  const fetchItems = () => {
    setError(false);
    load()
      .then((list) => setItems(list.slice(0, 24)))
      .catch(() => setError(true));
  };

  useEffect(() => {
    if (fixedItems) {
      setItems(fixedItems);
      return;
    }
    if (visible) fetchItems();
  }, [fixedItems, visible]);

  const scrollBy = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' });
  };

  return (
    <section ref={sectionRef} aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-center justify-between h-11">
        <h2 className="m-0 text-[18px] font-semibold tracking-[-0.01em]">{title}</h2>
        <div className="hidden sm:flex">
          <IconButton label={t('Anterior')} onClick={() => scrollBy(-1)}>
            <ChevronLeft size={20} />
          </IconButton>
          <IconButton label={t('Próximo')} onClick={() => scrollBy(1)}>
            <ChevronRight size={20} />
          </IconButton>
        </div>
      </div>
      {error ? (
        <div className="flex items-center gap-3 h-[120px] text-[14px] text-lu-muted">
          {t('Não deu pra carregar essa lista.')}
          <TextButton tone="accent" size="sm" onClick={fetchItems}>
            <RefreshCw size={14} />
            {t('Tentar de novo')}
          </TextButton>
        </div>
      ) : (
        <div ref={scroller} className="flex gap-4 overflow-x-auto no-scrollbar snap-x scroll-px-1 -mx-1 px-1 pb-1">
          {items
            ? items.map((item) => (
                <div key={item.id} className="snap-start">
                  <PosterCard item={item} onOpen={onOpen} />
                </div>
              ))
            : Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="w-[128px] sm:w-[152px] flex-none flex flex-col gap-2">
                  <span className="w-full aspect-[2/3] rounded-xl bg-lu-surface border border-lu-border animate-pulse" />
                  <span className="h-3.5 w-3/4 rounded bg-lu-surface animate-pulse" />
                </div>
              ))}
        </div>
      )}
    </section>
  );
};

// ───────────────────────── Detalhe ─────────────────────────

/** Selo com a marca de uma fonte (IMDb, MyAnimeList): vira link para a página do título quando há endereço. */
const BrandBadge: React.FC<{ href?: string; label: string; icon: React.ReactNode; children: React.ReactNode }> = ({ href, label, icon, children }) => {
  const cls = 'inline-flex items-center gap-2 h-10 px-3 border border-white/18 rounded-lg text-[15px] font-semibold text-lu-text no-underline';
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" title={label} aria-label={label} className={cx(cls, 'hover:bg-white/8')}>
      {icon}
      {children}
    </a>
  ) : (
    <span title={label} className={cls}>
      {icon}
      {children}
    </span>
  );
};

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
  onPlayStream: (stream: StreamOption, title: string, seriesContext?: CatalogSeriesContext) => void;
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

const Detail: React.FC<DetailProps> = ({ item, initialSeason = null, episodeId, onEpisodeChange, addons, onOpenAddons, onBack, onWatch, onPlayStream }) => {
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
  const activePoster = (isSeries && data.seasonPosters?.[currentSeasonStr]) || item.poster || data.poster;
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
                currentEpisodeId: openEpisode.id,
                season: openEpisode.season,
                episode: openEpisode.episode,
                episodes: data.episodes,
              }
            : undefined;
        onPlayStream(stream, episodeTitle, seriesContext);
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

      {!isSeries && !error && <section className="px-4 sm:px-12 pt-2">{streamsList}</section>}

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

// ───────────────────────── Fileiras da Home (do manifesto da fonte) ─────────────────────────

const HomeRows: React.FC<{
  manifest: CatalogManifest | null | 'error';
  onOpen: (item: CatalogItem) => void;
  onRetry: () => void;
  onCreateRoom: () => void;
}> = ({ manifest, onOpen, onRetry, onCreateRoom }) => {
  if (manifest === null) {
    return (
      <>
        {[0, 1].map((i) => (
          <Row key={i} title=" " load={async () => []} onOpen={onOpen} lazy />
        ))}
      </>
    );
  }
  if (manifest === 'error') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <span className="w-[72px] h-[72px] rounded-[20px] bg-lu-surface border border-lu-border text-lu-muted flex items-center justify-center">
          <SearchX size={32} />
        </span>
        <h1 className="mt-2 mb-0 text-[22px] font-semibold tracking-[-0.02em]">{t('O catálogo não respondeu')}</h1>
        <p className="m-0 max-w-[440px] text-[14px] text-lu-muted">
          {t('O catálogo está fora do ar agora. Se você já tem o vídeo, dá pra criar a sala direto.')}
        </p>
        <div className="flex flex-wrap justify-center gap-3 mt-3">
          <GhostButton onClick={onRetry}>
            <RefreshCw size={16} />
            <span>{t('Tentar de novo')}</span>
          </GhostButton>
          <PrimaryButton onClick={onCreateRoom}>
            <Users size={18} />
            <span>{t('Criar sala com um vídeo')}</span>
          </PrimaryButton>
        </div>
      </div>
    );
  }
  if (manifest.rows.length === 0) {
    return <p className="m-0 text-center text-[14px] text-lu-muted py-10">{t('Esta fonte não tem listas para mostrar. Use a busca.')}</p>;
  }
  const titles = rowTitles(manifest.rows);
  return (
    <>
      {manifest.stale && (
        <p className="m-0 text-[13px] text-lu-muted text-center">{t('O catálogo está fora do ar; mostrando o último conteúdo guardado.')}</p>
      )}
      {manifest.rows.map((row: CatalogRow, i) => (
        <Row key={`${row.type}:${row.id}`} title={titles[i]} load={() => fetchRow(row)} onOpen={onOpen} lazy />
      ))}
    </>
  );
};

// ───────────────────────── Aba ─────────────────────────

type SearchMode = 'groups' | 'unified';
type Filter = 'all' | 'movie' | 'series';
const SEARCH_MODE_KEY = 'lunio_search_mode';

function readSearchMode(): SearchMode {
  try {
    return localStorage.getItem(SEARCH_MODE_KEY) === 'unified' ? 'unified' : 'groups';
  } catch {
    return 'groups';
  }
}

export const CatalogTab: React.FC<CatalogTabProps> = ({ initialQuery = '', initialDetail = null, initialSeason = null, onWatch, onPlayStream, onCreateRoom }) => {
  const [query, setQuery] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery.trim());
  /** Um grupo por catálogo de busca da fonte (como no Stremio). */
  const [results, setResults] = useState<SearchGroup[] | null>(null);
  const [searchError, setSearchError] = useState(false);
  /** Por grupos (um por catálogo de busca, como no Stremio) ou unificada (tudo junto, sem repetidos, com filtro). */
  const [mode, setMode] = useState<SearchMode>(readSearchMode);
  const [filter, setFilter] = useState<Filter>('all');
  // Um link com `?detail=` abre o título direto; os dados completos vêm do detalhe
  const [selected, setSelected] = useState<CatalogItem | null>(() => (initialDetail ? { id: initialDetail.id, type: initialDetail.type, name: '' } : null));
  const [myList, setMyList] = useState<CatalogItem[]>(() => getMyList());
  /** As fileiras vêm do manifesto da fonte configurada no servidor (na ordem dela). */
  const [manifest, setManifest] = useState<CatalogManifest | null | 'error'>(null);
  const [manifestTry, setManifestTry] = useState(0);
  const [addonsOpen, setAddonsOpen] = useState(false);
  const [addons, setAddons] = useState<VideoAddon[]>(() => loadAddons());
  /** Episódio aberto (`/detail/<tipo>/<id>/<videoId>`); trocar de título o zera. */
  const [episodeId, setEpisodeId] = useState<string | null>(initialDetail?.videoId ?? null);
  const openItem = (item: CatalogItem) => {
    setEpisodeId(null);
    setSelected(item);
  };

  useEffect(() => {
    let cancelled = false;
    setManifest(null);
    fetchManifest()
      .then((m) => !cancelled && setManifest(m))
      .catch(() => !cancelled && setManifest('error'));
    return () => {
      cancelled = true;
    };
  }, [manifestTry]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  // A busca vai para o endereço (e sai dele quando a aba fecha). Com um título aberto a rota é só /detail/…: a busca volta
  // ao endereço quando o título fecha (ela continua aqui, no estado)
  useEffect(() => {
    writeSearchToUrl(selected ? '' : debounced);
  }, [debounced, selected]);
  useEffect(() => () => writeSearchToUrl(''), []);
  // O título aberto também vai para o endereço
  useEffect(() => {
    writeDetailToUrl(selected ? { type: selected.type, id: selected.id, videoId: episodeId ?? undefined } : null);
  }, [selected, episodeId]);
  useEffect(() => () => writeDetailToUrl(null), []);

  useEffect(() => {
    if (!debounced) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setResults(null);
    setSearchError(false);
    setFilter('all');
    searchCatalog(debounced)
      .then((list) => !cancelled && setResults(list))
      .catch(() => !cancelled && setSearchError(true));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  useEffect(() => {
    if (!selected) setMyList(getMyList());
    window.scrollTo({ top: 0 });
  }, [selected]);

  if (selected) {
    const fromUrl = initialDetail && initialDetail.id === selected.id && initialDetail.type === selected.type;
    return (
      <>
        <Detail
          key={`${selected.type}/${selected.id}`}
          item={selected}
          initialSeason={fromUrl ? initialSeason : null}
          episodeId={episodeId}
          onEpisodeChange={setEpisodeId}
          addons={addons}
          onOpenAddons={() => setAddonsOpen(true)}
          onBack={() => {
            setEpisodeId(null);
            setSelected(null);
          }}
          onWatch={onWatch}
          onPlayStream={onPlayStream}
        />
        <AddonsPanel open={addonsOpen} onClose={() => setAddonsOpen(false)} onChange={setAddons} />
      </>
    );
  }

  const groupsTotal = results?.reduce((n, g) => n + g.metas.length, 0) ?? 0;
  const groupTitles = results ? rowTitles(results) : [];
  const unified = results ? mergeGroups(results) : [];
  const movies = unified.filter((r) => !isSeriesType(r.type));
  const series = unified.filter((r) => isSeriesType(r.type));
  const shown = filter === 'all' ? unified : filter === 'movie' ? movies : series;
  const total = mode === 'unified' ? unified.length : groupsTotal;
  const chooseMode = (next: SearchMode) => {
    setMode(next);
    try {
      localStorage.setItem(SEARCH_MODE_KEY, next);
    } catch {
      // vale só nesta sessão
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-center gap-3">
        <div className="flex items-center gap-3 w-[640px] max-w-full h-[52px] pl-[18px] pr-2 rounded-[14px] bg-lu-surface border border-lu-border focus-within:border-lu-accent focus-within:shadow-[0_0_0_3px_var(--color-lu-tint)]">
          <span className="flex text-lu-muted">
            <Search size={20} />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Busque um filme ou série…')}
            aria-label={t('Buscar filmes e séries')}
            className="flex-1 min-w-0 h-11 border-0 outline-0 bg-transparent text-lu-text font-[inherit] text-[15px] focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <IconButton label={t('Limpar busca')} size={40} tone="muted" onClick={() => setQuery('')}>
              <X size={16} />
            </IconButton>
          )}
        </div>
        <GhostButton onClick={() => setAddonsOpen(true)}>
          <Puzzle size={16} />
          <span>{t('Addons')}</span>
        </GhostButton>
      </div>
      <AddonsPanel open={addonsOpen} onClose={() => setAddonsOpen(false)} onChange={setAddons} />

      {debounced ? (
        results === null && !searchError ? (
          <div className="flex items-center justify-center gap-2 py-16 text-lu-muted">
            <Spinner size={18} className="text-lu-accent" />
            {t('Buscando…')}
          </div>
        ) : searchError || (results && groupsTotal === 0) ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <span className="w-[72px] h-[72px] rounded-[20px] bg-lu-surface border border-lu-border text-lu-muted flex items-center justify-center">
              <SearchX size={32} />
            </span>
            <h1 className="mt-2 mb-0 text-[22px] font-semibold tracking-[-0.02em]">
              {searchError ? t('A busca não respondeu') : t('Nada encontrado pra “{debounced}”', { debounced })}
            </h1>
            <p className="m-0 max-w-[440px] text-[14px] text-lu-muted">
              {searchError
                ? t('O catálogo está fora do ar agora. Se você já tem o vídeo, dá pra criar a sala direto.')
                : t('Confira a ortografia ou tente o nome original. Se você já tem o vídeo, dá pra criar a sala direto.')}
            </p>
            <div className="flex flex-wrap justify-center gap-3 mt-3">
              <GhostButton onClick={() => setQuery('')}>
                <X size={16} />
                <span>{t('Limpar busca')}</span>
              </GhostButton>
              <PrimaryButton onClick={onCreateRoom}>
                <Users size={18} />
                <span>{t('Criar sala com um vídeo')}</span>
              </PrimaryButton>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="m-0 text-[14px] text-lu-muted">
                <strong className="text-lu-text font-semibold">
                  {total} {total === 1 ? t('resultado') : t('resultados')}
                </strong>{' '}
                pra “{debounced}”
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {mode === 'unified' && (
                  <PillTabs
                    label={t('Filtrar')}
                    size="sm"
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: 'all' as Filter, label: t('Tudo') },
                      { value: 'movie' as Filter, label: t('Filmes · {length}', { length: movies.length }) },
                      { value: 'series' as Filter, label: t('Séries · {length}', { length: series.length }) },
                    ]}
                  />
                )}
                <PillTabs
                  label={t('Modo de busca')}
                  size="sm"
                  value={mode}
                  onChange={chooseMode}
                  options={[
                    { value: 'groups' as SearchMode, label: t('Por grupos') },
                    { value: 'unified' as SearchMode, label: t('Unificada') },
                  ]}
                />
              </div>
            </div>
            {mode === 'groups' ? (
              results!.map((group, i) => (
                <Row key={`${group.type}:${group.id}`} title={groupTitles[i]} load={async () => group.metas} items={group.metas} onOpen={openItem} />
              ))
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(152px,1fr))] gap-x-4 gap-y-6">
                {shown.map((item) => (
                  <PosterCard key={`${item.type}-${item.id}`} item={item} onOpen={openItem} showType fluid />
                ))}
              </div>
            )}
          </>
        )
      ) : (
        <>
          {myList.length > 0 && <Row title={t('Minha lista')} load={async () => myList} items={myList} onOpen={openItem} />}
          <HomeRows manifest={manifest} onOpen={openItem} onRetry={() => setManifestTry((n) => n + 1)} onCreateRoom={onCreateRoom} />
        </>
      )}
    </div>
  );
};
