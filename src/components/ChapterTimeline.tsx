import React, { useState, useRef, useCallback } from 'react';
import { Check } from 'lucide-react';
import { Chapter } from '../types/media';
import { formatTime, getCurrentChapter } from '../lib/chapters';
import { t } from '../lib/i18n';

interface ChapterTimelineProps {
  currentTime: number;
  duration: number;
  buffered: number;
  bufferedRanges?: { start: number; end: number }[];
  chapters: Chapter[];
  onSeek: (time: number) => void;
  disabled?: boolean;
}

interface Segment {
  start: number;
  end: number;
}

/**
 * Timeline segmentada: um trilho por capítulo (com 3px de respiro), cada um com
 * o buffer em branco translúcido e o progresso em accent, como no design "Player · Início".
 */
export const ChapterTimeline: React.FC<ChapterTimelineProps> = ({
  currentTime,
  duration,
  buffered,
  bufferedRanges,
  chapters,
  onSeek,
  disabled = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragTime, setDragTime] = useState<number | null>(null);

  const safeDuration = duration > 0 && isFinite(duration) ? duration : 1;
  const displayTime = dragTime !== null ? dragTime : currentTime;
  const progressPercent = Math.min(100, Math.max(0, (displayTime / safeDuration) * 100));

  const ranges: Segment[] =
    bufferedRanges && bufferedRanges.length > 0 ? bufferedRanges : buffered > 0 ? [{ start: 0, end: buffered }] : [];

  const segments: Segment[] =
    chapters.length > 1 && duration > 0
      ? chapters
          .map((c, idx) => ({
            start: Math.max(0, c.startTime),
            end: Math.min(safeDuration, c.endTime ?? chapters[idx + 1]?.startTime ?? safeDuration),
          }))
          .filter((s) => s.end > s.start)
      : [{ start: 0, end: safeDuration }];

  const calculateTimeFromEvent = useCallback(
    (clientX: number): number => {
      if (!containerRef.current) return 0;
      const rect = containerRef.current.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return pos * safeDuration;
    },
    [safeDuration]
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.stopPropagation();
    setIsDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragTime(calculateTimeFromEvent(e.clientX));
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverPosition(pos * 100);
    const timeAtPos = pos * safeDuration;
    setHoverTime(timeAtPos);
    if (isDragging && !disabled) setDragTime(timeAtPos);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const finalTime = dragTime !== null ? dragTime : calculateTimeFromEvent(e.clientX);
    onSeek(finalTime);
    setDragTime(null);
    setIsDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handlePointerLeave = () => {
    if (!isDragging) {
      setHoverPosition(null);
      setHoverTime(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // Atalhos globais de ←/→ já fazem seek de 10s; aqui só evitamos o duplo disparo.
      e.stopPropagation();
      e.preventDefault();
      onSeek(Math.max(0, Math.min(safeDuration, currentTime + (e.key === 'ArrowRight' ? step : -step))));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onSeek(0);
    }
  };

  const hoveredChapter = hoverTime !== null ? getCurrentChapter(hoverTime, chapters) : null;
  const hoverBuffered =
    hoverTime !== null ? ranges.some((r) => hoverTime >= r.start - 0.5 && hoverTime <= r.end + 0.5) : false;

  return (
    <div
      id="chapter-timeline-wrapper"
      ref={containerRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={t('Posição de reprodução')}
      aria-valuemin={0}
      aria-valuemax={Math.round(safeDuration)}
      aria-valuenow={Math.round(displayTime)}
      aria-valuetext={`${formatTime(displayTime)} de ${formatTime(duration)}`}
      aria-disabled={disabled || undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
      className={`group/tl relative h-6 flex items-center select-none touch-none rounded ${
        disabled ? 'cursor-default' : 'cursor-pointer'
      }`}
    >
      {hoverPosition !== null && hoverTime !== null && (
        <div
          id="timeline-hover-tooltip"
          className="absolute bottom-[calc(100%+6px)] -translate-x-1/2 px-3 py-2 rounded-[10px] bg-lu-elevated border border-lu-border shadow-[0_8px_24px_rgba(0,0,0,0.45)] whitespace-nowrap text-center pointer-events-none z-30"
          style={{ left: `clamp(64px, ${hoverPosition}%, calc(100% - 64px))` }}
        >
          {hoveredChapter && chapters.length > 0 && (
            <div className="text-[13px] font-semibold max-w-[220px] truncate">{hoveredChapter.title}</div>
          )}
          <div className="flex items-center justify-center gap-2 text-[12px] text-lu-muted tabular">
            <span>{formatTime(hoverTime)}</span>
            {ranges.length > 0 &&
              (hoverBuffered ? (
                <span className="inline-flex items-center gap-1 text-lu-success">
                  <Check size={12} />
                  {t('No buffer')}
                </span>
              ) : (
                <span>{t('Sem buffer')}</span>
              ))}
          </div>
        </div>
      )}

      <div className="flex gap-[3px] w-full h-1 group-hover/tl:h-1.5 transition-[height] duration-150">
        {segments.map((seg) => {
          const len = seg.end - seg.start;
          const playedPct = Math.min(100, Math.max(0, ((displayTime - seg.start) / len) * 100));
          return (
            <div
              key={`${seg.start}-${seg.end}`}
              className="relative min-w-0 h-full rounded-sm overflow-hidden bg-lu-elevated"
              style={{ flex: `${len} 1 0` }}
            >
              {ranges.map((r, idx) => {
                const from = Math.max(r.start, seg.start);
                const to = Math.min(r.end, seg.end);
                if (to <= from) return null;
                return (
                  <div
                    key={idx}
                    className="absolute top-0 bottom-0 bg-lu-text/18"
                    style={{ left: `${((from - seg.start) / len) * 100}%`, width: `${((to - from) / len) * 100}%` }}
                  />
                );
              })}
              <div id="timeline-played-bar" className="absolute left-0 top-0 bottom-0 bg-lu-accent" style={{ width: `${playedPct}%` }} />
            </div>
          );
        })}
      </div>

      <div
        id="timeline-scrubber-handle"
        className="absolute top-1/2 w-3.5 h-3.5 -mt-[7px] -ml-[7px] rounded-full bg-lu-accent-hover shadow-[0_0_0_4px_rgba(167,139,250,0.22)] pointer-events-none transition-transform duration-100 group-hover/tl:scale-110"
        style={{ left: `${progressPercent}%` }}
      />
    </div>
  );
};
