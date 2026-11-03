import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Compass, Puzzle, Search, SearchX, Users, X } from 'lucide-react';
import {
  CatalogItem,
  CatalogManifest,
  SearchGroup,
  fetchManifest,
  getMyList,
  isSeriesType,
  mergeGroups,
  rowTitles,
  searchCatalog,
} from '../../lib/catalog';
import { GhostButton, IconButton, PillTabs, PrimaryButton, Spinner } from '../ui';
import { t } from '../../lib/i18n';
import { DetailRef, DiscoverRef, discoverFromUrl, writeDetailToUrl, writeDiscoverToUrl, writeSearchToUrl } from '../../lib/searchUrl';
import { AddonsPanel } from './AddonsPanel';
import { Detail } from './Detail';
import { Discover } from './Discover';
import { HomeRows } from './HomeRows';
import { PosterCard } from './Poster';
import { Row } from './Row';
import { loadAddons, type VideoAddon } from '../../lib/addons';
import type { StreamOption } from '../../lib/streams';
import type { CatalogSeriesContext } from '../../types/media';
import type { WatchIntent } from './types';

export type { WatchIntent } from './types';

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
  // Explorar (o Descobrir do Stremio): aberto pelo botão ou por um link `/discover/<tipo>/<catálogo>`; continua montado por baixo do detalhe
  // para voltar à mesma grade e à mesma posição
  const initialDiscover = useMemo(() => discoverFromUrl(), []);
  const [discoverOpen, setDiscoverOpen] = useState(initialDiscover !== null);
  const [discoverSel, setDiscoverSel] = useState<DiscoverRef | null>(initialDiscover);
  const discoverScroll = useRef(0);
  const openItem = (item: CatalogItem) => {
    if (discoverOpen) discoverScroll.current = window.scrollY;
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
  // O Explorar também (depois do título: ao fechar o título, o endereço volta para o Explorar). Sem escolha ainda (a fonte está carregando),
  // o endereço do link fica como veio
  useEffect(() => {
    if (selected) return;
    if (!discoverOpen) writeDiscoverToUrl(null);
    else if (discoverSel) writeDiscoverToUrl(discoverSel);
  }, [selected, discoverOpen, discoverSel]);
  useEffect(() => () => writeDiscoverToUrl(null), []);

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
    window.scrollTo({ top: !selected && discoverOpen ? discoverScroll.current : 0 });
    // só ao abrir ou fechar um título
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  if (selected || discoverOpen) {
    const fromUrl = selected && initialDetail && initialDetail.id === selected.id && initialDetail.type === selected.type;
    // O Explorar fica no mesmo lugar da árvore com ou sem título aberto (escondido por baixo dele), então não perde a grade nem a posição
    return (
      <>
        {selected && (
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
        )}
        {selected && <AddonsPanel open={addonsOpen} onClose={() => setAddonsOpen(false)} onChange={setAddons} />}
        {discoverOpen && (
          <div hidden={Boolean(selected)}>
            <Discover
              manifest={manifest}
              initial={initialDiscover}
              onChange={setDiscoverSel}
              onOpen={openItem}
              onBack={() => setDiscoverOpen(false)}
              onRetry={() => setManifestTry((n) => n + 1)}
              onCreateRoom={onCreateRoom}
            />
          </div>
        )}
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
        <GhostButton
          onClick={() => {
            setDiscoverSel(null);
            setDiscoverOpen(true);
          }}
        >
          <Compass size={16} />
          <span>{t('Explorar')}</span>
        </GhostButton>
        <GhostButton onClick={() => setAddonsOpen(true)}>
          <Puzzle size={16} />
          <span>{t('Addons')}</span>
        </GhostButton>
        <GhostButton disabled title={t('Em breve')}>
          <CalendarDays size={16} />
          <span>{t('Calendário')}</span>
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
