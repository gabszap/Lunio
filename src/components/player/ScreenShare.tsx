import React, { useEffect, useRef, useState } from 'react';
import { MonitorUp, TriangleAlert, X } from 'lucide-react';
import { SCREEN_QUALITIES, screenQuality, type ScreenQualityId } from '../../types/screen';
import { qualityCost } from '../../lib/screen/quality';
import { getLang, t } from '../../lib/i18n';
import { Dot, GhostButton, Hint, IconButton, MenuItem, MenuPanel, PrimaryButton, Spinner, cx, useDismiss } from '../ui';
import { useScreenShare } from './ScreenShareContext';

const floatingCard = 'bg-lu-surface/90 backdrop-blur-md border border-lu-border shadow-[0_16px_40px_rgba(0,0,0,0.45)]';

const fmt = (n: number) => n.toLocaleString(getLang() === 'pt' ? 'pt-BR' : 'en-US', { maximumFractionDigits: 1 });

function costText(id: ScreenQualityId): string {
  const q = screenQuality(id)!;
  const { mbps, gbPerHour } = qualityCost(q);
  return t('até {mbps} Mbps · ~{gb} GB/h por pessoa', { mbps: fmt(mbps), gb: fmt(gbPerHour) });
}

/**
 * Botão do Host para transmitir a tela, com o menu de qualidade. `variant="icon"` vai na barra do player;
 * `variant="button"` serve para a tela sem vídeo. Só aparece para o Host de uma sala, em navegador capaz e com a
 * transmissão ligada no servidor.
 */
export const ScreenShareControl: React.FC<{ open: boolean; onOpenChange: (open: boolean) => void; variant?: 'icon' | 'button' }> = ({
  open,
  onOpenChange,
  variant = 'icon',
}) => {
  const s = useScreenShare();
  const ref = useRef<HTMLDivElement>(null);
  const [choice, setChoice] = useState<ScreenQualityId>(s.lastQuality);
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  useDismiss(open, close, ref);
  useEffect(() => setChoice(s.lastQuality), [s.lastQuality]);

  if (!s.canBroadcast) return null;

  const busy = s.host.status === 'starting' || s.host.status === 'live';
  const label = busy ? t('Parar transmissão') : t('Transmitir a tela');

  return (
    <div className="relative" ref={ref}>
      {variant === 'icon' ? (
        <IconButton id="btn-screen-share" label={label} aria-expanded={open} active={busy || open} onClick={() => onOpenChange(!open)}>
          <MonitorUp size={20} />
        </IconButton>
      ) : (
        <GhostButton id="btn-screen-share" aria-expanded={open} onClick={() => onOpenChange(!open)}>
          <MonitorUp size={18} />
          <span>{label}</span>
        </GhostButton>
      )}

      {open && (
        <MenuPanel id="screen-share-menu" title={t('Transmitir a tela')} onClose={close} className="right-[-48px] w-[340px]">
          {busy ? (
            <div className="flex flex-col gap-3 px-2.5 pb-2.5">
              <div className="flex items-center gap-2 text-[14px]">
                {s.host.status === 'starting' ? <Spinner size={16} /> : <Dot tone="error" pulse />}
                <span>{s.host.status === 'starting' ? t('Conectando à transmissão…') : t('Transmitindo')}</span>
              </div>
              <GhostButton
                block
                onClick={() => {
                  s.stopBroadcast();
                  close();
                }}
              >
                {t('Parar transmissão')}
              </GhostButton>
            </div>
          ) : (
            <>
              <div role="radiogroup" aria-label={t('Transmitir a tela')} className="flex flex-col gap-0.5 pb-1">
                {SCREEN_QUALITIES.map((q) => (
                  <MenuItem key={q.id} selected={choice === q.id} onClick={() => setChoice(q.id)} label={q.label} tall />
                ))}
              </div>
              <div className="flex flex-col gap-2 px-2.5 pb-2.5">
                <Hint>{costText(choice)}</Hint>
                {choice.startsWith('2160') && <Hint tone="error">{t('Exige boa internet de subida e que quem assiste decodifique 4K.')}</Hint>}
                <Hint>{t('No seletor, escolha a tela inteira ou outra janela; a aba do Lunio não aparece.')}</Hint>
                {s.host.notice && <Hint>{s.host.notice}</Hint>}
                <PrimaryButton
                  block
                  onClick={() => {
                    close();
                    void s.startBroadcast(screenQuality(choice)!);
                  }}
                >
                  {t('Transmitir')}
                </PrimaryButton>
              </div>
            </>
          )}
        </MenuPanel>
      )}
    </div>
  );
};

/** O mesmo botão para a tela sem vídeo (o Host pode transmitir sem ter escolhido um vídeo). */
export const ScreenShareStandbyButton: React.FC = () => {
  const [open, setOpen] = useState(false);
  return <ScreenShareControl variant="button" open={open} onOpenChange={setOpen} />;
};

/** Faixa sobre o vídeo do Host enquanto ele transmite (ou quando deu erro). */
export const ScreenHostPill: React.FC = () => {
  const s = useScreenShare();
  const { status, error, hasSubscribers } = s.host;
  if (status === 'idle' && !error) return null;
  const quality = s.screen ? screenQuality(s.screen.quality) : null;

  return (
    <div className={cx('absolute top-20 left-3 z-40 flex items-center gap-3 rounded-[14px] px-3.5 py-2 text-[13px]', floatingCard)} role="status">
      {error ? (
        <>
          <TriangleAlert size={16} className="text-lu-error flex-none" />
          <span className="max-w-[320px]">{error}</span>
          <IconButton label={t('Fechar')} size={36} tone="muted" onClick={s.dismissError}>
            <X size={16} />
          </IconButton>
        </>
      ) : status === 'starting' ? (
        <>
          <Spinner size={16} />
          <span>{t('Conectando à transmissão…')}</span>
        </>
      ) : (
        <>
          <Dot tone="error" pulse />
          <span className="font-medium">{t('Transmitindo')}</span>
          {quality && <span className="text-lu-muted">{quality.label}</span>}
          <span className="text-lu-muted">{hasSubscribers ? t('Alguém assistindo') : t('Ninguém assistindo ainda')}</span>
          <GhostButton onClick={s.stopBroadcast} className="!h-9 !px-3">
            {t('Parar transmissão')}
          </GhostButton>
        </>
      )}
    </div>
  );
};

/**
 * Palco do espectador, por cima do vídeo da sala: o cartão "Assistir transmissão", a imagem da transmissão (um canvas)
 * com "Voltar ao vídeo", os estados de conexão, erro e fim. O vídeo da sala continua por baixo, mudo e sincronizado.
 */
export const ScreenStage: React.FC = () => {
  const s = useScreenShare();
  const { status, error } = s.viewer;
  const available = s.canWatch && !s.isBroadcaster && Boolean(s.screen?.live);

  return (
    <>
      <canvas ref={s.attachCanvas} aria-hidden="true" className={cx('absolute inset-0 z-[5] w-full h-full bg-black object-contain', !s.covering && 'hidden')} />

      {s.covering && status === 'connecting' && (
        <div className="absolute inset-0 z-[6] flex items-center justify-center gap-3 text-[14px] pointer-events-none" role="status">
          <Spinner size={20} />
          <span>{t('Conectando à transmissão…')}</span>
        </div>
      )}

      {s.covering && (
        <GhostButton onClick={s.returnToVideo} className="absolute top-20 right-3 z-40 !h-10">
          {t('Voltar ao vídeo')}
        </GhostButton>
      )}

      {available && !s.covering && status !== 'error' && (
        <div className={cx('absolute top-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-4 rounded-[16px] px-4 py-3 max-w-[calc(100%-32px)]', floatingCard)}>
          <Dot tone="error" pulse />
          <span className="text-[14px] font-medium">{t('O Host está transmitindo a tela')}</span>
          <PrimaryButton onClick={s.watch}>{t('Assistir transmissão')}</PrimaryButton>
        </div>
      )}

      {status === 'error' && (
        <div className={cx('absolute top-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-[16px] px-4 py-3 max-w-[calc(100%-32px)]', floatingCard)} role="alert">
          <TriangleAlert size={18} className="text-lu-error flex-none" />
          <span className="text-[14px]">{error}</span>
          {available && <GhostButton onClick={s.watch}>{t('Tentar de novo')}</GhostButton>}
          <IconButton label={t('Fechar')} size={36} tone="muted" onClick={s.dismissError}>
            <X size={16} />
          </IconButton>
        </div>
      )}

      {s.endedNotice && (
        <div className={cx('absolute bottom-24 left-1/2 -translate-x-1/2 z-40 rounded-[14px] px-4 py-2.5 text-[14px]', floatingCard)} role="status">
          {t('A transmissão acabou')}
        </div>
      )}
    </>
  );
};
