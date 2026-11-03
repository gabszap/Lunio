import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, RefreshCw, SearchX, Users } from 'lucide-react';
import { CatalogItem, CatalogManifest, DiscoverEntry, fetchRow } from '../../lib/catalog';
import { GhostButton, PrimaryButton, Spinner, TextButton } from '../ui';
import { t } from '../../lib/i18n';
import type { DiscoverRef } from '../../lib/searchUrl';
import { PosterCard } from './Poster';
import { Select } from './Select';

/** O servidor recusa `skip` acima disto. */
const MAX_SKIP = 5000;

/** Tipos conhecidos em português; os de outros addons aparecem com o nome que a fonte deu, capitalizado. */
const TYPE_LABELS: Record<string, () => string> = {
  movie: () => t('Filmes'),
  series: () => t('Séries'),
  anime: () => t('Anime'),
};
export function typeLabel(type: string): string {
  const known = TYPE_LABELS[type];
  if (known) return known();
  const spaced = type.replace(/[._-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** O que está escolhido: o catálogo certo para o tipo e um gênero válido (ou, sendo obrigatório, o primeiro). */
export function resolveSelection(entries: DiscoverEntry[], want: DiscoverRef | null): { entry: DiscoverEntry; genre: string | undefined } | null {
  if (entries.length === 0) return null;
  const entry = (want && entries.find((e) => e.type === want.type && e.id === want.id)) || entries[0];
  const genre = want?.genre && entry.genres.includes(want.genre) ? want.genre : entry.genreRequired ? entry.genres[0] : undefined;
  return { entry, genre };
}

export const Discover: React.FC<{
  manifest: CatalogManifest | null | 'error';
  /** O que o endereço pediu (tipo, catálogo, gênero); o que não existir na fonte cai no primeiro catálogo. */
  initial: DiscoverRef | null;
  onChange: (ref: DiscoverRef) => void;
  onOpen: (item: CatalogItem) => void;
  onBack: () => void;
  onRetry: () => void;
  onCreateRoom: () => void;
}> = ({ manifest, initial, onChange, onOpen, onBack, onRetry, onCreateRoom }) => {
  const entries = useMemo(() => (manifest && manifest !== 'error' ? manifest.discover ?? [] : []), [manifest]);
  const [want, setWant] = useState<DiscoverRef | null>(initial);
  const sel = useMemo(() => resolveSelection(entries, want), [entries, want]);

  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);
  // Cada pedido leva o número da escolha em que nasceu: resposta de uma escolha antiga é descartada
  const runRef = useRef(0);
  const countRef = useRef(0);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const entry = sel?.entry;
  const genre = sel?.genre;
  const key = entry ? `${entry.type}/${entry.id}/${genre ?? ''}` : '';

  const loadPage = useCallback(
    (run: number) => {
      if (!entry || loadingRef.current) return;
      const skip = countRef.current;
      if (skip >= MAX_SKIP) {
        setDone(true);
        return;
      }
      loadingRef.current = true;
      setLoading(true);
      setError(false);
      fetchRow(entry, genre, skip)
        .then((page) => {
          if (run !== runRef.current) return;
          countRef.current += page.length;
          setItems((prev) => {
            const seen = new Set(prev.map((i) => `${i.type}:${i.id}`));
            const fresh = page.filter((i) => !seen.has(`${i.type}:${i.id}`));
            // Página vazia ou só de repetidos: acabou (também quando o catálogo não pagina)
            if (fresh.length === 0 || !entry.paged) setDone(true);
            return fresh.length ? [...prev, ...fresh] : prev;
          });
        })
        .catch(() => {
          if (run === runRef.current) setError(true);
        })
        .finally(() => {
          if (run !== runRef.current) return;
          loadingRef.current = false;
          setLoading(false);
        });
    },
    [entry, genre]
  );

  // Trocou tipo, catálogo ou gênero: recomeça do zero
  useEffect(() => {
    if (!key || !entry) return;
    runRef.current += 1;
    countRef.current = 0;
    loadingRef.current = false;
    setItems([]);
    setDone(false);
    setError(false);
    loadPage(runRef.current);
    onChange({ type: entry.type, id: entry.id, genre });
    // `entry`, `genre` e `onChange` acompanham a `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Chegou perto do fim da grade: carrega a próxima página
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || done || error || items.length === 0) return;
    const io = new IntersectionObserver((hits) => hits[0]?.isIntersecting && loadPage(runRef.current), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [items.length, done, error, loadPage]);

  const types = useMemo(() => [...new Set(entries.map((e) => e.type))], [entries]);
  const catalogs = entries.filter((e) => e.type === entry?.type);

  const pickType = (type: string) => setWant({ type, id: entries.find((e) => e.type === type)!.id });
  const pickCatalog = (id: string) => setWant({ type: entry!.type, id });
  const pickGenre = (g: string) => setWant({ type: entry!.type, id: entry!.id, genre: g || undefined });

  const header = (
    <div className="flex items-center justify-between gap-3">
      <TextButton onClick={onBack} className="!pl-2 -ml-2">
        <ChevronLeft size={18} />
        <span>{t('Catálogo')}</span>
      </TextButton>
    </div>
  );

  if (manifest === null) {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <div className="flex items-center justify-center gap-2 py-16 text-lu-muted">
          <Spinner size={18} className="text-lu-accent" />
          {t('Carregando…')}
        </div>
      </div>
    );
  }
  if (manifest === 'error' || !sel || !entry) {
    const failed = manifest === 'error';
    return (
      <div className="flex flex-col gap-8">
        {header}
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <span className="w-[72px] h-[72px] rounded-[20px] bg-lu-surface border border-lu-border text-lu-muted flex items-center justify-center">
            <SearchX size={32} />
          </span>
          <h1 className="mt-2 mb-0 text-[22px] font-semibold tracking-[-0.02em]">{failed ? t('O catálogo não respondeu') : t('Nada para explorar')}</h1>
          <p className="m-0 max-w-[440px] text-[14px] text-lu-muted">
            {failed ? t('O catálogo está fora do ar agora. Se você já tem o vídeo, dá pra criar a sala direto.') : t('Esta fonte não tem catálogos para explorar. Use a busca.')}
          </p>
          <div className="flex flex-wrap justify-center gap-3 mt-3">
            {failed && (
              <GhostButton onClick={onRetry}>
                <RefreshCw size={16} />
                <span>{t('Tentar de novo')}</span>
              </GhostButton>
            )}
            <PrimaryButton onClick={onCreateRoom}>
              <Users size={18} />
              <span>{t('Criar sala com um vídeo')}</span>
            </PrimaryButton>
          </div>
        </div>
      </div>
    );
  }

  const genreOptions = [...(entry.genreRequired ? [] : [{ value: '', label: t('Nenhum') }]), ...entry.genres.map((g) => ({ value: g, label: g }))];

  return (
    <div className="flex flex-col gap-6">
      {header}
      <h1 className="m-0 text-[28px] font-bold tracking-[-0.02em]">{t('Explorar')}</h1>
      <div className="flex flex-wrap gap-3">
        <Select label={t('Tipo')} value={entry.type} options={types.map((ty) => ({ value: ty, label: typeLabel(ty) }))} onChange={pickType} className="w-[200px] max-w-full" />
        <Select label={t('Catálogo da fonte')} value={entry.id} options={catalogs.map((c) => ({ value: c.id, label: c.name }))} onChange={pickCatalog} className="w-[260px] max-w-full" />
        {entry.genres.length > 0 && <Select label={t('Gênero')} value={genre ?? ''} options={genreOptions} onChange={pickGenre} className="w-[220px] max-w-full" />}
      </div>

      {items.length === 0 && loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-lu-muted">
          <Spinner size={18} className="text-lu-accent" />
          {t('Carregando…')}
        </div>
      ) : items.length === 0 && error ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="m-0 text-[14px] text-lu-muted">{t('Não deu pra carregar esse catálogo.')}</p>
          <GhostButton onClick={() => loadPage(runRef.current)}>
            <RefreshCw size={16} />
            <span>{t('Tentar de novo')}</span>
          </GhostButton>
        </div>
      ) : items.length === 0 ? (
        <p className="m-0 text-center text-[14px] text-lu-muted py-16">{t('Nada para mostrar aqui.')}</p>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(152px,1fr))] gap-x-4 gap-y-6">
            {items.map((item) => (
              <PosterCard key={`${item.type}-${item.id}`} item={item} onOpen={onOpen} fluid />
            ))}
          </div>
          <div ref={sentinelRef} aria-hidden="true" className="h-px" />
          {loading && (
            <div className="flex items-center justify-center gap-2 py-4 text-lu-muted">
              <Spinner size={16} className="text-lu-accent" />
            </div>
          )}
          {error && (
            <div className="flex justify-center py-4">
              <GhostButton onClick={() => loadPage(runRef.current)}>
                <RefreshCw size={16} />
                <span>{t('Tentar de novo')}</span>
              </GhostButton>
            </div>
          )}
        </>
      )}
    </div>
  );
};
