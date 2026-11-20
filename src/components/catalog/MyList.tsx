import type { FC } from 'react';
import { ChevronLeft } from 'lucide-react';
import type { CatalogItem } from '../../lib/catalog';
import { t } from '../../lib/i18n';
import { TextButton } from '../ui';
import { PosterCard } from './Poster';

export const MyList: FC<{
  items: CatalogItem[];
  onOpen: (item: CatalogItem) => void;
  onBack: () => void;
}> = ({ items, onOpen, onBack }) => (
  <div className="flex flex-col gap-6">
    <TextButton onClick={onBack} className="self-start !pl-2 -ml-2">
      <ChevronLeft size={18} aria-hidden="true" />
      {t('Catálogo')}
    </TextButton>
    <h1 className="m-0 text-[28px] font-bold tracking-[-0.02em]">{t('Minha lista')}</h1>
    {items.length > 0 ? (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(152px,1fr))] gap-x-4 gap-y-6">
        {items.map((item) => <PosterCard key={`${item.type}:${item.id}`} item={item} onOpen={onOpen} fluid />)}
      </div>
    ) : (
      <p className="m-0 py-16 text-center text-[14px] text-lu-muted">{t('Salve filmes e séries pelos detalhes de cada título.')}</p>
    )}
  </div>
);
