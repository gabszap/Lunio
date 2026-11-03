import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Film, MonitorUp, Repeat, TriangleAlert, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import { SCREEN_QUALITIES, screenQuality, type ScreenQualityId } from '../../types/screen';
import { qualityCost } from '../../lib/screen/quality';
import { getLang, t } from '../../lib/i18n';
import { Dot, GhostButton, Hint, IconButton, MenuItem, MenuPanel, Modal, ModalHeader, PrimaryButton, Spinner, cx, useDismiss } from '../ui';
import { useScreenShare, type ScreenShareValue } from './ScreenShareContext';

const floatingCard = 'bg-lu-surface/90 backdrop-blur-md border border-lu-border shadow-[0_16px_40px_rgba(0,0,0,0.45)]';

const fmt = (n: number) => n.toLocaleString(getLang() === 'pt' ? 'pt-BR' : 'en-US', { maximumFractionDigits: 1 });

function costText(id: ScreenQualityId): string {
  const q = screenQuality(id)!;
  const { mbps, gbPerHour } = qualityCost(q);
  return t('até {mbps} Mbps · ~{gb} GB/h por pessoa', { mbps: fmt(mbps), gb: fmt(gbPerHour) });
}

/** Lista de qualidades, avisos e o botão de começar (ou o de parar, se já estiver transmitindo). */
const ShareMenuBody: React.FC<{
  s: ScreenShareValue;
  choice: ScreenQualityId;
  setChoice: (id: ScreenQualityId) => void;
  close: () => void;
}> = ({ s, choice, setChoice, close }) => {
  const busy = s.host.status === 'starting' || s.host.status === 'live';
  if (busy) {
    return (
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
    );
  }
  return (
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
  );
};

/**
 * Botão do Host para transmitir a tela, com o menu de qualidade. `variant="icon"` vai na barra do player (menu que abre
 * para cima); `variant="button"` serve para a tela sem vídeo e abre numa janela centralizada (um menu que abre para cima
 * ali saía da tela). Só aparece para o Host de uma sala, em navegador capaz e com a transmissão ligada no servidor.
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
  useDismiss(open && variant === 'icon', close, ref);
  useEffect(() => setChoice(s.lastQuality), [s.lastQuality]);

  if (!s.canBroadcast) return null;

  const busy = s.host.status === 'starting' || s.host.status === 'live';
  // O botão abre o menu (onde está o "Parar transmissão"): o nome acessível é sempre o do menu
  const label = t('Transmitir a tela');

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

      {open && variant === 'icon' && (
        <MenuPanel id="screen-share-menu" title={t('Transmitir a tela')} onClose={close} className="right-[-48px] w-[340px]">
          <ShareMenuBody s={s} choice={choice} setChoice={setChoice} close={close} />
        </MenuPanel>
      )}

      {variant === 'button' && (
        <Modal open={open} onClose={close} label={t('Transmitir a tela')} width={380} className="!p-3 !gap-1">
          <ModalHeader title={t('Transmitir a tela')} onClose={close} />
          <ShareMenuBody s={s} choice={choice} setChoice={setChoice} close={close} />
        </Modal>
      )}
    </div>
  );
};

/** O mesmo botão para a tela sem vídeo (o Host pode transmitir sem ter escolhido um vídeo). */
export const ScreenShareStandbyButton: React.FC = () => {
  const [open, setOpen] = useState(false);
  return <ScreenShareControl variant="button" open={open} onOpenChange={setOpen} />;
};

/** Prévia do que o Host está transmitindo (a mesma imagem que vai ao relay). */
const HostPreview: React.FC<{ stream: MediaStream }> = ({ stream }) => {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline aria-hidden="true" className="w-full aspect-video rounded-[10px] bg-black object-contain" />;
};

/** Faixa sobre o vídeo do Host enquanto ele transmite (ou quando deu erro). */
export const ScreenHostPill: React.FC = () => {
  const s = useScreenShare();
  const [showPreview, setShowPreview] = useState(false);
  const { status, error, stats, preview } = s.host;
  if (status === 'idle' && !error) return null;
  const quality = s.screen ? screenQuality(s.screen.quality) : null;

  if (error) {
    return (
      <div className={cx('absolute top-20 left-3 z-40 flex items-center gap-3 rounded-[14px] px-3.5 py-2 text-[13px]', floatingCard)} role="alert">
        <TriangleAlert size={16} className="text-lu-error flex-none" />
        <span className="max-w-[320px]">{error}</span>
        <IconButton label={t('Fechar')} size={36} tone="muted" onClick={s.dismissError}>
          <X size={16} />
        </IconButton>
      </div>
    );
  }

  if (status === 'starting') {
    return (
      <div className={cx('absolute top-20 left-3 z-40 flex items-center gap-3 rounded-[14px] px-3.5 py-2 text-[13px]', floatingCard)} role="status">
        <Spinner size={16} />
        <span>{t('Conectando à transmissão…')}</span>
      </div>
    );
  }

  const names = s.viewers.map((v) => v.username);
  const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');

  return (
    <div className={cx('absolute top-20 left-3 z-40 flex flex-col gap-2.5 rounded-[14px] px-3.5 py-3 text-[13px] w-[min(360px,calc(100%-24px))]', floatingCard)} role="status">
      <div className="flex items-center gap-2 flex-wrap">
        <Dot tone="error" pulse />
        <span className="font-medium">{t('Transmitindo')}</span>
        {quality && <span className="text-lu-muted">{quality.label}</span>}
        {stats && <span className="text-lu-muted tabular">{t('{fps} fps · {mbps} Mbps', { fps: stats.fps, mbps: fmt(stats.mbps) })}</span>}
      </div>

      <div className="flex items-center gap-2 text-lu-muted min-w-0">
        <Eye size={14} className="flex-none" />
        {names.length ? <span className="truncate">{t('Assistindo ({n}): {names}', { n: names.length, names: shown })}</span> : <span>{t('Ninguém assistindo ainda')}</span>}
      </div>

      {showPreview && preview && (
        <div className="flex flex-col gap-1.5">
          <HostPreview stream={preview} />
          <p className="m-0 text-[11px] text-lu-muted">{t('Se você compartilha a tela inteira, a prévia aparece dentro dela (efeito espelho).')}</p>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {preview && (
          <GhostButton onClick={() => setShowPreview((v) => !v)} className="!h-9 !px-3" aria-pressed={showPreview}>
            {showPreview ? <EyeOff size={15} /> : <Eye size={15} />}
            <span>{showPreview ? t('Esconder a prévia') : t('Ver a prévia')}</span>
          </GhostButton>
        )}
        <GhostButton onClick={() => void s.switchScreen()} className="!h-9 !px-3">
          <Repeat size={15} />
          <span>{t('Trocar a tela')}</span>
        </GhostButton>
        <GhostButton onClick={s.stopBroadcast} className="!h-9 !px-3">
          {t('Parar transmissão')}
        </GhostButton>
      </div>
    </div>
  );
};

/** Controles de quem assiste: volume da transmissão e "Voltar ao vídeo". */
const ScreenViewerBar: React.FC<{ s: ScreenShareValue }> = ({ s }) => {
  const effective = s.muted ? 0 : s.volume;
  const Icon = effective === 0 ? VolumeX : effective < 0.5 ? Volume1 : Volume2;
  return (
    <div className={cx('absolute top-20 right-3 z-40 flex items-center gap-1.5 rounded-[14px] pl-1.5 pr-2 py-1.5', floatingCard)}>
      <IconButton label={s.muted ? t('Ativar o som da transmissão') : t('Silenciar a transmissão')} size={36} onClick={s.toggleMuted}>
        <Icon size={18} />
      </IconButton>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        aria-label={t('Volume da transmissão')}
        value={effective}
        onChange={(e) => s.setVolume(parseFloat(e.target.value))}
        className="w-[88px] m-0 cursor-pointer max-sm:hidden"
      />
      <span className="w-px h-5 bg-lu-border mx-1.5" aria-hidden="true" />
      <GhostButton onClick={s.returnToVideo} className="!h-9 !px-3 text-[13px]">
        <Film size={15} />
        <span>{t('Voltar ao vídeo')}</span>
      </GhostButton>
    </div>
  );
};

/**
 * Palco do espectador, por cima do vídeo da sala: o cartão "Assistir transmissão", a imagem da transmissão (um canvas)
 * com os controles de volume e "Voltar ao vídeo", os estados de conexão, erro e fim. O vídeo da sala continua por baixo,
 * mudo e sincronizado.
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

      {s.covering && <ScreenViewerBar s={s} />}

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
