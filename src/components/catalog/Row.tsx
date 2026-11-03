import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import {
  CatalogItem,
} from '../../lib/catalog';
import { IconButton, TextButton } from '../ui';
import { t } from '../../lib/i18n';
import { PosterCard } from './Poster';

// ───────────────────────── Fileira com rolagem ─────────────────────────

export const Row: React.FC<{
  title: string;
  load: () => Promise<CatalogItem[]>;
  onOpen: (item: CatalogItem) => void;
  items?: CatalogItem[];
  /** Só pede os itens quando a fileira chega perto da tela (uma fonte pode ter dezenas de fileiras). */
  lazy?: boolean;
  /** Como desenhar cada item (o padrão é o cartaz simples). */
  renderItem?: (item: CatalogItem) => React.ReactNode;
}> = ({ title, load, onOpen, items: fixedItems, lazy = false, renderItem }) => {
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
                  {renderItem ? renderItem(item) : <PosterCard item={item} onOpen={onOpen} />}
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
