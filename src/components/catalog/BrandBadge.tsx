import React from 'react';
import { cx } from '../ui';

/** Selo com a marca de uma fonte (IMDb, MyAnimeList): vira link para a página do título quando há endereço. */
export const BrandBadge: React.FC<{ href?: string; label: string; icon: React.ReactNode; children: React.ReactNode }> = ({ href, label, icon, children }) => {
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
