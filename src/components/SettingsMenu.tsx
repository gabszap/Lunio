import React, { useRef, useState } from 'react';
import { Settings } from 'lucide-react';
import { logger } from '../lib/logger';
import { Chip, ChipRow, IconButton, MenuDivider, MenuPanel, MenuSection, Segmented, Slider, useDismiss } from './ui';
import { t } from '../lib/i18n';

interface SettingsMenuProps {
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
  volumeBoost: number; // 100 to 200
  onVolumeBoostChange: (boost: number) => void;
  audioDelay?: number; // 0.0 to 5.0 in seconds
  onAudioDelayChange?: (delay: number) => void;
  subtitleDelay?: number; // -10.0 to 10.0 in seconds
  onSubtitleDelayChange?: (delay: number) => void;
  subtitleFontSize?: number; // 50 to 250 in percent
  onSubtitleFontSizeChange?: (size: number) => void;
  /** Espectadores não mudam a velocidade da sala. */
  canChangeRate?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}

const SPEED_PRESETS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const AUDIO_DELAY_PRESETS = [0.05, 0.1, 0.25, 0.5];
const FONT_SIZE_PRESETS = [75, 100, 125, 150, 175];

export const formatRate = (rate: number) => `${Number(rate.toFixed(2)).toString().replace('.', ',')}×`;

export const formatMs = (seconds: number, signed = true) => {
  const ms = Math.round(seconds * 1000);
  if (ms === 0) return '0 ms';
  return `${signed && ms > 0 ? '+' : ms < 0 ? '−' : ''}${Math.abs(ms)} ms`;
};

export const SettingsMenu: React.FC<SettingsMenuProps> = ({
  playbackRate,
  onPlaybackRateChange,
  volumeBoost,
  onVolumeBoostChange,
  audioDelay = 0,
  onAudioDelayChange,
  subtitleDelay = 0,
  onSubtitleDelayChange,
  subtitleFontSize = 100,
  onSubtitleFontSizeChange,
  canChangeRate = true,
  open,
  onOpenChange,
  disabled = false,
}) => {
  const [activeTab, setActiveTab] = useState<'audio' | 'subtitles'>('audio');
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(open, () => onOpenChange(false), menuRef);

  const handleSpeedChange = (rate: number) => {
    onPlaybackRateChange(rate);
    logger.setting('Velocidade', formatRate(rate));
  };

  return (
    <div id="settings-menu-container" className="relative" ref={menuRef}>
      <IconButton
        id="btn-settings-toggle"
        label={t('Ajustes')}
        aria-expanded={open}
        active={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        <Settings size={20} className={`transition-transform ${open ? 'rotate-45' : ''}`} />
      </IconButton>

      {open && (
        <MenuPanel
          id="settings-popover-panel"
          title={t('Ajustes')}
          onClose={() => onOpenChange(false)}
          className="right-0 md:right-[-140px] w-[360px]"
        >
          <Segmented
            label={t('Seção de ajustes')}
            size="sm"
            value={activeTab}
            onChange={(v) => setActiveTab(v as 'audio' | 'subtitles')}
            className="mx-0.5 mt-0.5 mb-3"
            options={[
              { value: 'audio', label: t('Áudio e velocidade') },
              { value: 'subtitles', label: t('Legendas e sync') },
            ]}
          />

          {activeTab === 'audio' && (
            <>
              <MenuSection title={t('Velocidade de reprodução')} value={formatRate(playbackRate)}>
                <Slider
                  id="slider-playback-speed"
                  min="0.25"
                  max="2"
                  step="0.05"
                  value={playbackRate}
                  disabled={!canChangeRate}
                  aria-label={t('Velocidade de reprodução')}
                  onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
                />
                <ChipRow gap="tight">
                  {SPEED_PRESETS.map((rate) => (
                    <Chip
                      key={rate}
                      selected={Math.abs(playbackRate - rate) < 0.001}
                      disabled={!canChangeRate}
                      onClick={() => handleSpeedChange(rate)}
                    >
                      {formatRate(rate)}
                    </Chip>
                  ))}
                </ChipRow>
                {!canChangeRate && (
                  <p className="mt-2 mb-0 text-[12px] text-lu-muted">{t('Só o Host muda a velocidade da sala.')}</p>
                )}
              </MenuSection>

              {onAudioDelayChange && (
                <>
                  <MenuDivider />
                  <MenuSection
                    title={t('Atraso do áudio')}
                    value={formatMs(audioDelay)}
                    description={t('Atrasa o áudio caso a voz saia antes da imagem.')}
                  >
                    <Slider
                      id="slider-audio-delay"
                      min="0"
                      max="2"
                      step="0.05"
                      value={audioDelay}
                      aria-label={t('Atraso do áudio')}
                      onChange={(e) => onAudioDelayChange(parseFloat(e.target.value))}
                    />
                    <ChipRow gap="tight">
                      <Chip dense selected={audioDelay === 0} onClick={() => onAudioDelayChange(0)}>
                        {t('Redefinir')}
                      </Chip>
                      {AUDIO_DELAY_PRESETS.map((d) => (
                        <Chip key={d} dense selected={Math.abs(audioDelay - d) < 0.01} onClick={() => onAudioDelayChange(d)}>
                          +{Math.round(d * 1000)} ms
                        </Chip>
                      ))}
                    </ChipRow>
                  </MenuSection>
                </>
              )}

              <MenuDivider />
              <MenuSection
                title={t('Volume boost')}
                value={`${volumeBoost}%`}
                description={t('Amplifica streams com áudio baixo.')}
                last
              >
                <Slider
                  id="slider-volume-boost"
                  min="100"
                  max="200"
                  step="5"
                  value={volumeBoost}
                  aria-label={t('Volume boost')}
                  onChange={(e) => onVolumeBoostChange(parseInt(e.target.value, 10))}
                />
                <ChipRow gap="tight">
                  {[100, 150, 200].map((b) => (
                    <Chip key={b} selected={volumeBoost === b} onClick={() => onVolumeBoostChange(b)}>
                      {b}%
                    </Chip>
                  ))}
                </ChipRow>
              </MenuSection>
            </>
          )}

          {activeTab === 'subtitles' && (
            <>
              {onSubtitleDelayChange && (
                <MenuSection
                  title={t('Sincronia da legenda')}
                  value={formatMs(subtitleDelay)}
                  description={t('Positivo atrasa a legenda; negativo adianta. Atalhos: G e H.')}
                >
                  <Slider
                    id="slider-subtitle-delay"
                    min="-5"
                    max="5"
                    step="0.05"
                    value={subtitleDelay}
                    aria-label={t('Sincronia da legenda')}
                    onChange={(e) => onSubtitleDelayChange(parseFloat(e.target.value))}
                  />
                  <ChipRow gap="tight">
                    {[-0.25, -0.05].map((d) => (
                      <Chip key={d} dense onClick={() => onSubtitleDelayChange(Number((subtitleDelay + d).toFixed(2)))}>
                        {formatMs(d)}
                      </Chip>
                    ))}
                    <Chip dense selected={subtitleDelay === 0} onClick={() => onSubtitleDelayChange(0)}>
                      {t('Redefinir')}
                    </Chip>
                    {[0.05, 0.25].map((d) => (
                      <Chip key={d} dense onClick={() => onSubtitleDelayChange(Number((subtitleDelay + d).toFixed(2)))}>
                        {formatMs(d)}
                      </Chip>
                    ))}
                  </ChipRow>
                </MenuSection>
              )}

              {onSubtitleFontSizeChange && (
                <>
                  <MenuDivider />
                  <MenuSection title={t('Tamanho da fonte')} value={`${subtitleFontSize}%`} last>
                    <ChipRow gap="tight">
                      {FONT_SIZE_PRESETS.map((sz) => (
                        <Chip key={sz} selected={subtitleFontSize === sz} onClick={() => onSubtitleFontSizeChange(sz)}>
                          {sz}%
                        </Chip>
                      ))}
                    </ChipRow>
                  </MenuSection>
                </>
              )}
            </>
          )}
        </MenuPanel>
      )}
    </div>
  );
};
