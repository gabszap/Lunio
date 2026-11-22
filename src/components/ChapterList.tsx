import React, { useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { Chapter } from '../types/media';
import { formatTime, getCurrentChapter } from '../lib/chapters';
import { logger } from '../lib/logger';
import { MenuItem, MenuPanel, cx, useDismiss } from './ui';
import { t } from '../lib/i18n';

interface ChapterListProps {
  chapters: Chapter[];
  currentTime: number;
  onSeek: (time: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}

/**
 * Nome do capítulo atual clicável no topo esquerdo do player — abre a lista de capítulos para baixo.
 */
export const ChapterList: React.FC<ChapterListProps> = ({
  chapters,
  currentTime,
  onSeek,
  open,
  onOpenChange,
  disabled = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  useDismiss(open, () => onOpenChange(false), containerRef);

  if (!chapters || chapters.length === 0) {
    return null;
  }

  const currentChapter = getCurrentChapter(currentTime, chapters);
  const label = currentChapter?.title || t('Capítulos');

  const handleSelectChapter = (chap: Chapter) => {
    onSeek(chap.startTime);
    logger.action(`[Player] Capítulo "${chap.title}" (${formatTime(chap.startTime)})`);
    onOpenChange(false);
  };

  if (disabled) {
    return (
      <span id="player-active-chapter-badge" className="truncate text-[13px] text-lu-muted">
        {label}
      </span>
    );
  }

  return (
    <div id="chapter-list-menu-container" className="relative inline-flex min-w-0" ref={containerRef}>
      <button
        id="btn-chapters-menu-toggle"
        type="button"
        aria-label={t('Capítulos')}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          onOpenChange(!open);
        }}
        className={cx(
          'inline-flex items-center gap-1 max-w-full -ml-1.5 px-1.5 py-0.5 rounded-md text-[13px] transition-colors min-w-0',
          open ? 'bg-white/10 text-lu-text' : 'text-lu-muted hover:text-lu-text hover:bg-white/8'
        )}
      >
        <span id="player-active-chapter-badge" className="truncate">
          {label}
        </span>
        <ChevronDown size={14} className={cx('flex-none transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <MenuPanel
          id="chapter-list-popover"
          title={t('Capítulos')}
          meta={`${chapters.length} ${chapters.length === 1 ? t('capítulo') : t('capítulos')}`}
          onClose={() => onOpenChange(false)}
          className="!top-full !bottom-auto !mt-2 !mb-0 left-0 w-[340px]"
        >
          <div className="flex flex-col gap-0.5 pb-1">
            {chapters.map((chap, idx) => {
              const isCurrent =
                currentChapter?.title === chap.title && currentChapter?.startTime === chap.startTime;
              return (
                <MenuItem
                  key={`${chap.title}-${chap.startTime}`}
                  tall
                  selected={isCurrent}
                  onClick={() => handleSelectChapter(chap)}
                  leading={
                    <span className={`w-5 text-[12px] tabular ${isCurrent ? 'text-lu-accent' : 'text-lu-disabled'}`}>
                      {(idx + 1).toString().padStart(2, '0')}
                    </span>
                  }
                  label={chap.title}
                  trailing={<span className="text-[12px] tabular text-lu-muted">{formatTime(chap.startTime)}</span>}
                />
              );
            })}
          </div>
        </MenuPanel>
      )}
    </div>
  );
};
