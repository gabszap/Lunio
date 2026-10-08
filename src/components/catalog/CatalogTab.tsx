import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, ChevronLeft, ChevronRight, Film, Play, Search, SearchX, Star, Tv, Users, X, RefreshCw } from 'lucide-react';
import {
  CatalogItem,
  CatalogMeta,
  CatalogType,
  GENRES_PT,
  episodeTag,
  fetchMeta,
  fetchTop,
  getMyList,
  isInMyList,
  searchCatalog,
  toggleMyList,
} from '../../lib/catalog';
import { GhostButton, IconButton, PillTabs, PrimaryButton, Spinner, TextButton, cx } from '../ui';
import { t } from '../../lib/i18n';

export interface WatchIntent {
  title: string;
  preferSolo: boolean;
}

interface CatalogTabProps {
  onWatch: (intent: WatchIntent) => void;
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
  return (
    <span
      className={cx('relative flex-none rounded-xl border border-lu-border overflow-hidden flex items-center justify-center text-lu-text/35', className)}
      style={{ background: gradientFor(item.id) }}
    >
      {item.poster && !failed ? (
        <img src={item.poster} alt="" loading="lazy" onError={() => setFailed(true)} className="absolute inset-0 w-full h-full object-cover" />
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
        {showType ? `${item.type === 'series' ? t('Série') : t('Filme')}${item.year ? ` · ${item.year}` : ''}` : item.year || ' '}
      </span>
    </span>
  </button>
);

// ───────────────────────── Fileira com rolagem ─────────────────────────

const Row: React.FC<{ title: string; load: () => Promise<CatalogItem[]>; onOpen: (item: CatalogItem) => void; items?: CatalogItem[] }> = ({
  title,
  load,
  onOpen,
  items: fixedItems,
}) => {
  const [items, setItems] = useState<CatalogItem[] | null>(fixedItems ?? null);
  const [error, setError] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

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
    fetchItems();
  }, [fixedItems]);

  const scrollBy = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' });
  };

  return (
    <section aria-label={title} className="flex flex-col gap-2">
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

const Detail: React.FC<{ item: CatalogItem; onBack: () => void; onWatch: (intent: WatchIntent) => void }> = ({ item, onBack, onWatch }) => {
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const [error, setError] = useState(false);
  const [season, setSeason] = useState<number>(1);
  const [saved, setSaved] = useState(() => isInMyList(item.id));

  useEffect(() => {
    setMeta(null);
    setError(false);
    fetchMeta(item.type, item.id)
      .then((m) => {
        setMeta(m);
        const first = m.episodes.find((e) => e.season >= 1)?.season;
        if (first) setSeason(first);
      })
      .catch(() => setError(true));
  }, [item]);

  const data = meta ?? { ...item, genres: [], episodes: [] as CatalogMeta['episodes'], description: undefined, runtime: undefined, imdbRating: undefined, background: undefined };
  const seasons = useMemo(() => Array.from(new Set(data.episodes.map((e) => e.season))).sort((a, b) => a - b), [data.episodes]);
  const episodes = data.episodes.filter((e) => e.season === season);
  const isSeries = item.type === 'series';
  const firstEpisode = data.episodes[0];

  const watchTitle = (preferSolo: boolean) => {
    const title = isSeries && firstEpisode ? `${data.name} · ${episodeTag(firstEpisode.season, firstEpisode.episode)}` : data.name;
    onWatch({ title, preferSolo });
  };

  const metaLine = [
    data.year,
    isSeries && seasons.length ? `${seasons.length} ${seasons.length === 1 ? t('temporada') : t('temporadas')}` : data.runtime,
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
            <Poster item={data} iconSize={48} className="w-[160px] sm:w-[240px] aspect-[2/3]" />
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
                  {data.imdbRating && (
                    <span className="inline-flex items-center gap-1 px-1.5 border border-white/18 rounded text-[12px] font-semibold">
                      <Star size={12} />
                      {data.imdbRating}
                    </span>
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

      {isSeries && seasons.length > 0 && (
        <section aria-label={t('Episódios')} className="px-4 sm:px-12 pt-2 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="m-0 text-[18px] font-semibold">{t('Episódios')}</h2>
            <div className="max-w-full overflow-x-auto no-scrollbar">
              <PillTabs
                label={t('Temporadas')}
                size="sm"
                value={String(season)}
                onChange={(v) => setSeason(Number(v))}
                options={seasons.map((s) => ({ value: String(s), label: t('Temporada {s}', { s }) }))}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {episodes.map((ep) => (
              <button
                key={ep.id}
                type="button"
                onClick={() => onWatch({ title: `${data.name} · ${episodeTag(ep.season, ep.episode)}`, preferSolo: false })}
                className="group flex items-start gap-4 p-3 rounded-[14px] bg-lu-bg2 border border-lu-border hover:bg-white/6 text-left w-full"
              >
                <span
                  className="relative w-[128px] sm:w-[176px] aspect-video flex-none rounded-[10px] overflow-hidden flex items-center justify-center"
                  style={{ background: gradientFor(ep.id) }}
                >
                  {ep.thumbnail && (
                    <img src={ep.thumbnail} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" onError={(e) => (e.currentTarget.style.display = 'none')} />
                  )}
                  <span className="relative opacity-0 group-hover:opacity-100 transition-opacity w-10 h-10 rounded-full bg-lu-video/70 flex items-center justify-center">
                    <Play size={18} />
                  </span>
                </span>
                <span className="flex flex-col gap-1 min-w-0">
                  <span className="text-[14px] font-semibold">
                    {ep.episode}. {ep.title}
                  </span>
                  <span className="text-[12px] text-lu-muted">
                    {[episodeTag(ep.season, ep.episode), ep.released ? new Date(ep.released).toLocaleDateString('pt-BR') : null].filter(Boolean).join(' · ')}
                  </span>
                  {ep.overview && <span className="text-[13px] leading-snug text-lu-muted line-clamp-2">{ep.overview}</span>}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};

// ───────────────────────── Aba ─────────────────────────

type Filter = 'all' | CatalogType;

export const CatalogTab: React.FC<CatalogTabProps> = ({ onWatch, onCreateRoom }) => {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState<CatalogItem[] | null>(null);
  const [searchError, setSearchError] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [myList, setMyList] = useState<CatalogItem[]>(() => getMyList());

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(t);
  }, [query]);

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
    return <Detail item={selected} onBack={() => setSelected(null)} onWatch={onWatch} />;
  }

  const movies = results?.filter((r) => r.type === 'movie') ?? [];
  const series = results?.filter((r) => r.type === 'series') ?? [];
  const shown = filter === 'all' ? results ?? [] : filter === 'movie' ? movies : series;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex justify-center">
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
      </div>

      {debounced ? (
        results === null && !searchError ? (
          <div className="flex items-center justify-center gap-2 py-16 text-lu-muted">
            <Spinner size={18} className="text-lu-accent" />
            {t('Buscando…')}
          </div>
        ) : searchError || (results && results.length === 0) ? (
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
                  {results!.length} {results!.length === 1 ? t('resultado') : t('resultados')}
                </strong>{' '}
                pra “{debounced}”
              </p>
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
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(152px,1fr))] gap-x-4 gap-y-6">
              {shown.map((item) => (
                <PosterCard key={`${item.type}-${item.id}`} item={item} onOpen={setSelected} showType fluid />
              ))}
            </div>
          </>
        )
      ) : (
        <>
          {myList.length > 0 && <Row title={t('Minha lista')} load={async () => myList} items={myList} onOpen={setSelected} />}
          <Row title={t('Filmes populares')} load={() => fetchTop('movie')} onOpen={setSelected} />
          <Row title={t('Séries populares')} load={() => fetchTop('series')} onOpen={setSelected} />
          <Row title={t('Ação')} load={() => fetchTop('movie', 'Action')} onOpen={setSelected} />
        </>
      )}
    </div>
  );
};
