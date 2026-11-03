import React, { useEffect, useState } from 'react';
import { Film } from 'lucide-react';
import {
  CatalogItem,
  isSeriesType,
} from '../../lib/catalog';
import { cx } from '../ui';
import { t } from '../../lib/i18n';

const PLACEHOLDER_GRADIENTS = [
  'linear-gradient(160deg,#2A2250,#14172B)',
  'linear-gradient(160deg,#1B2F4A,#101826)',
  'linear-gradient(160deg,#3A2260,#171230)',
  'linear-gradient(160deg,#173A47,#0E1A24)',
  'linear-gradient(160deg,#2E2A57,#12132A)',
  'linear-gradient(160deg,#40305E,#1A1328)',
];

export const gradientFor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PLACEHOLDER_GRADIENTS[h % PLACEHOLDER_GRADIENTS.length];
};

// ───────────────────────── Pôster ─────────────────────────

export const Poster: React.FC<{ item: CatalogItem; className?: string; iconSize?: number }> = ({ item, className, iconSize = 32 }) => {
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

export const PosterCard: React.FC<{
  item: CatalogItem;
  onOpen: (item: CatalogItem) => void;
  showType?: boolean;
  fluid?: boolean;
  /** 0 a 1: barra de progresso no pé do cartaz ("continuar assistindo"). */
  progress?: number;
}> = ({ item, onOpen, showType, fluid, progress }) => (
  <button
    type="button"
    onClick={() => onOpen(item)}
    className={cx('group flex flex-col items-start gap-2 text-left rounded-xl flex-none', fluid ? 'w-full' : 'w-[128px] sm:w-[152px]')}
  >
    <span className="relative block w-full">
      <Poster item={item} className="w-full aspect-[2/3] transition-transform group-hover:-translate-y-0.5" />
      {progress !== undefined && progress > 0 && (
        <span
          role="progressbar"
          aria-label={t('Progresso')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          className="absolute left-2 right-2 bottom-2 h-1 rounded-full bg-black/55 overflow-hidden"
        >
          <span className="block h-full rounded-full bg-lu-accent" style={{ width: `${Math.min(100, Math.round(progress * 100))}%` }} />
        </span>
      )}
    </span>
    <span className="flex flex-col min-w-0 w-full">
      <span className="text-[13px] font-semibold text-lu-text leading-snug line-clamp-2 break-words" title={item.name}>{item.name}</span>
      <span className="text-[12px] text-lu-muted">
        {showType ? `${isSeriesType(item.type) ? t('Série') : t('Filme')}${item.year ? ` · ${item.year}` : ''}` : item.year || ' '}
      </span>
    </span>
  </button>
);
