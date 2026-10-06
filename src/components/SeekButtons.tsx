import React from 'react';
import { RotateCcw, RotateCw, FastForward } from 'lucide-react';
import { logger } from '../lib/logger';
import { formatTime } from '../lib/chapters';

interface SeekButtonsProps {
  currentTime: number;
  duration: number;
  onSeek: (newTime: number) => void;
  disabled?: boolean;
}

const seekBtn =
  'inline-flex items-center justify-center flex-none gap-1.5 h-11 px-3 rounded-[10px] text-[13px] font-semibold tabular transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

export const SeekButtons: React.FC<SeekButtonsProps> = ({ currentTime, duration, onSeek, disabled = false }) => {
  const seekBy = (delta: number, label: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    const max = duration > 0 ? duration : Infinity;
    const newTime = Math.max(0, Math.min(max, currentTime + delta));
    onSeek(newTime);
    logger.action(`[Player] ${label} → ${formatTime(newTime)}`);
  };

  return (
    <>
      <button
        id="btn-seek-backward-10"
        type="button"
        aria-label="Voltar 10 segundos (←)"
        title="Voltar 10 segundos (←)"
        disabled={disabled}
        onClick={seekBy(-10, 'Voltar 10 s')}
        className={`${seekBtn} hidden sm:inline-flex text-lu-text hover:bg-white/8`}
      >
        <RotateCcw size={18} />
        <span>10 s</span>
      </button>
      <button
        id="btn-seek-forward-10"
        type="button"
        aria-label="Avançar 10 segundos (→)"
        title="Avançar 10 segundos (→)"
        disabled={disabled}
        onClick={seekBy(10, 'Avançar 10 s')}
        className={`${seekBtn} hidden sm:inline-flex text-lu-text hover:bg-white/8`}
      >
        <span>10 s</span>
        <RotateCw size={18} />
      </button>
      <button
        id="btn-seek-forward-90"
        type="button"
        aria-label="Pular abertura (N)"
        title="Pular abertura (N)"
        disabled={disabled}
        onClick={seekBy(90, 'Pular 90 s')}
        className={`${seekBtn} hidden md:inline-flex bg-lu-tint text-lu-accent hover:bg-lu-accent/20`}
      >
        <FastForward size={18} />
        <span>+90 s</span>
      </button>
    </>
  );
};
