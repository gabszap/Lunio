import React from 'react';
import { Volume2, Volume1, VolumeX } from 'lucide-react';
import { IconButton } from './ui';

interface VolumeDisplayProps {
  volume: number; // 0 to 1
  muted: boolean;
  onVolumeChange: (volume: number) => void;
  onMuteToggle: () => void;
  disabled?: boolean;
}

export const VolumeDisplay: React.FC<VolumeDisplayProps> = ({
  volume,
  muted,
  onVolumeChange,
  onMuteToggle,
  disabled = false,
}) => {
  const effectiveVolume = muted ? 0 : volume;
  const percentage = Math.round(effectiveVolume * 100);

  const Icon = muted || percentage === 0 ? VolumeX : percentage < 50 ? Volume1 : Volume2;

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    onVolumeChange(val);
    if (muted && val > 0) {
      onMuteToggle();
    }
  };

  return (
    <div id="volume-display-container" className="hidden md:flex items-center gap-1">
      <IconButton
        id="btn-volume-mute-toggle"
        label={muted ? 'Ativar som (M)' : 'Silenciar (M)'}
        disabled={disabled}
        onClick={onMuteToggle}
      >
        <Icon size={20} />
      </IconButton>
      <input
        id="volume-slider-input"
        type="range"
        min="0"
        max="1"
        step="0.01"
        aria-label="Volume"
        disabled={disabled}
        value={effectiveVolume}
        onChange={handleSliderChange}
        className="w-[84px] m-0 cursor-pointer"
      />
      <span id="volume-percentage-text" className="w-[38px] text-right text-[12px] tabular text-lu-muted select-none">
        {percentage}%
      </span>
    </div>
  );
};
