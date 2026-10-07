import React, { useRef } from 'react';
import { BookmarkMinus } from 'lucide-react';
import { Chapter } from '../types/media';
import { formatTime, getCurrentChapter } from '../lib/chapters';
import { logger } from '../lib/logger';
import { IconButton, MenuItem, MenuPanel, useDismiss } from './ui';
import { t } from '../lib/i18n';

interface ChapterListProps {
  chapters: Chapter[];
  currentTime: number;
  onSeek: (time: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}

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

  const handleSelectChapter = (chap: Chapter) => {
    onSeek(chap.startTime);
    logger.action(`[Player] Capítulo "${chap.title}" (${formatTime(chap.startTime)})`);
    onOpenChange(false);
  };

  return (
    <div id="chapter-list-menu-container" className="relative hidden sm:block" ref={containerRef}>
      <IconButton
        id="btn-chapters-menu-toggle"
        label={t('Capítulos')}
        aria-expanded={open}
        active={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        <BookmarkMinus size={20} />
      </IconButton>

      {open && (
        <MenuPanel
          id="chapter-list-popover"
          title={t('Capítulos')}
          meta={`${chapters.length} ${chapters.length === 1 ? t('capítulo') : t('capítulos')}`}
          onClose={() => onOpenChange(false)}
          className="right-0 w-[340px]"
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
