import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { t } from '../../lib/i18n';
import { IconButton, cx } from '../ui';

/** O conteúdo cresce dentro da barra, sem alargar a página nem comprimir os nomes das temporadas. */
export function SeasonTabs({ seasons, value, onChange }: { seasons: number[]; value: number; onChange: (season: number) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ overflow: false, start: true, end: true });
  const reveal = () => {
    const container = bar.current;
    const selected = container?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!container || !selected) return;
    const frame = container.getBoundingClientRect();
    const tab = selected.getBoundingClientRect();
    if (tab.left < frame.left + 5) container.scrollLeft += tab.left - frame.left - 5;
    else if (tab.right > frame.right - 5) container.scrollLeft += tab.right - frame.right + 5;
  };
  useEffect(() => {
    const container = bar.current;
    if (!container) return;
    const update = () => setEdges({ overflow: container.scrollWidth > container.clientWidth + 1, start: container.scrollLeft <= 1, end: container.scrollLeft + container.clientWidth >= container.scrollWidth - 1 });
    const observer = new ResizeObserver(() => { reveal(); update(); });
    observer.observe(container);
    container.addEventListener('scroll', update);
    update();
    return () => { observer.disconnect(); container.removeEventListener('scroll', update); };
  }, [seasons.length]);
  useEffect(reveal, [value, edges.overflow]);
  const move = (direction: number) => {
    const container = bar.current;
    if (container) container.scrollBy({ left: direction * Math.max(160, container.clientWidth * 0.8), behavior: 'smooth' });
  };
  return <div className="w-full min-w-0 flex items-center gap-1.5">
    {edges.overflow && <IconButton label={t('Temporadas anteriores')} size={36} disabled={edges.start} onClick={() => move(-1)}><ChevronLeft size={18} /></IconButton>}
    <div ref={bar} role="tablist" aria-label={t('Temporadas')} className="min-w-0 flex-1 flex gap-1 p-1 overflow-x-auto custom-scrollbar rounded-xl border border-lu-border bg-lu-bg2">
      {seasons.map((season, index) => <button key={season} type="button" role="tab" aria-selected={season === value} tabIndex={season === value ? 0 : -1}
        onClick={() => onChange(season)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % seasons.length : event.key === 'ArrowLeft' ? (index - 1 + seasons.length) % seasons.length : event.key === 'Home' ? 0 : event.key === 'End' ? seasons.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault();
          onChange(seasons[next]);
          bar.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
        }} className={cx('shrink-0 whitespace-nowrap h-9 px-3.5 rounded-lg text-[13px] font-semibold transition-colors', season === value ? 'bg-lu-tint text-lu-accent' : 'text-lu-muted hover:bg-white/8')}>
        {season === 0 ? t('Especiais') : t('Temporada {s}', { s: season })}
      </button>)}
    </div>
    {edges.overflow && <IconButton label={t('Próximas temporadas')} size={36} disabled={edges.end} onClick={() => move(1)}><ChevronRight size={18} /></IconButton>}
  </div>;
}
