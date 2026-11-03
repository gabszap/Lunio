import React, { useEffect, useRef, useState } from 'react';
import { ChevronUp, Eye, EyeOff, Film, Maximize, Minimize, MonitorOff, MonitorUp, Repeat, TriangleAlert, Users, Volume1, Volume2, VolumeX, X } from 'lucide-react';
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

/** "1080p · 60 fps" (ou "4K · 60 fps"): o rótulo curto da qualidade na barra do Host. */
const shortQuality = (id: ScreenQualityId): string => {
  const q = screenQuality(id)!;
  return `${q.height >= 2160 ? '4K' : `${q.height}p`} · ${q.fps} fps`;
};

/** "1080p60" (ou "4K60"): a qualidade da transmissão para quem assiste, sem os números ao vivo. */
const resolutionLabel = (id: ScreenQualityId): string => {
  const q = screenQuality(id)!;
  return `${q.height >= 2160 ? '4K' : `${q.height}p`}${q.fps}`;
};

/** O que o Host está enviando, como imagem do player (no lugar do "Nenhum vídeo na sala"). */
const HostPreviewBackdrop: React.FC<{ stream: MediaStream }> = ({ stream }) => {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline aria-hidden="true" className="absolute inset-0 z-[5] w-full h-full bg-black object-contain pointer-events-none" />;
};

// Barra flutuante embaixo, como a dos apps de compartilhar tela: pílula escura com botões de 40 px
// Vidro: fundo translúcido com desfoque forte e borda clara, para a imagem aparecer por trás (como nos apps de chamada)
const glass = 'bg-[#15151c]/70 backdrop-blur-2xl backdrop-saturate-150 border border-white/[0.12] shadow-[0_12px_40px_rgba(0,0,0,0.35)]';
const barBase = 'absolute left-1/2 -translate-x-1/2 z-40 w-max flex flex-nowrap items-center justify-center gap-1 rounded-full p-1.5 max-w-[calc(100%-24px)]';
const barBtn = 'inline-flex items-center justify-center h-10 rounded-full text-[13px] font-medium text-lu-text hover:bg-white/10 transition-colors flex-none';
const barInfo = 'inline-flex items-center gap-1.5 h-10 px-3.5 rounded-full bg-white/[0.08] text-[13px] text-lu-text/80 tabular whitespace-nowrap flex-none';

const Divider: React.FC = () => <span className="w-px h-6 bg-lu-border mx-1 flex-none" aria-hidden="true" />;

/** Tela cheia do player (o contêiner do vídeo ou da tela de espera). */
const FullscreenButton: React.FC = () => {
  const ref = useRef<HTMLButtonElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', sync);
    sync();
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    const target = ref.current?.closest<HTMLElement>('#video-player-root, #video-player-standby') ?? document.documentElement;
    void target.requestFullscreen?.();
  };
  return (
    <button ref={ref} type="button" aria-label={on ? t('Sair da tela cheia (F)') : t('Tela cheia (F)')} title={on ? t('Sair da tela cheia (F)') : t('Tela cheia (F)')} onClick={toggle} className={cx(barBtn, 'w-10')}>
      {on ? <Minimize size={18} /> : <Maximize size={18} />}
    </button>
  );
};

/** Seletor de qualidade com a transmissão no ar: abre para cima, a escolha vale já. */
const QualityPicker: React.FC<{ current: ScreenQualityId; onPick: (id: ScreenQualityId) => void }> = ({ current, onPick }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);
  return (
    <div className="relative" ref={ref}>
      <button type="button" aria-label={t('Qualidade da transmissão')} aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cx(barBtn, 'gap-1.5 px-3.5 bg-white/[0.08] whitespace-nowrap')}>
        <span className="tabular">{shortQuality(current)}</span>
        <ChevronUp size={14} className={cx('transition-transform', !open && 'rotate-180')} />
      </button>
      {open && (
        <MenuPanel title={t('Qualidade da transmissão')} onClose={close} className="left-0 w-[240px]">
          <div role="radiogroup" aria-label={t('Qualidade da transmissão')} className="flex flex-col gap-0.5 pb-1">
            {SCREEN_QUALITIES.map((q) => (
              <MenuItem
                key={q.id}
                selected={q.id === current}
                onClick={() => {
                  close();
                  if (q.id !== current) onPick(q.id);
                }}
                label={q.label}
                hint={`${fmt(qualityCost(q).mbps)} Mbps`}
              />
            ))}
          </div>
        </MenuPanel>
      )}
    </div>
  );
};

/** Quem está assistindo: o número na barra e os nomes ao passar o mouse. */
const ViewersChip: React.FC<{ viewers: Array<{ id: string; username: string }> }> = ({ viewers }) => {
  const names = viewers.map((v) => v.username);
  const label = names.length ? t('Assistindo ({n}): {names}', { n: names.length, names: names.join(', ') }) : t('Ninguém assistindo ainda');
  return (
    <div className="relative group/v flex-none" tabIndex={0} aria-label={label} role="status">
      <div className={cx(barInfo, names.length > 0 && 'text-lu-text')}>
        <Users size={15} />
        <span>{names.length}</span>
      </div>
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover/v:block group-focus/v:block rounded-[10px] px-3 py-2 text-[12px] whitespace-nowrap bg-lu-elevated border border-lu-border shadow-[0_12px_28px_rgba(0,0,0,0.5)] text-lu-text pointer-events-none">
        {names.length ? names.map((n) => <div key={n}>{n}</div>) : t('Ninguém assistindo ainda')}
      </div>
    </div>
  );
};

/** Barra do Host enquanto transmite: parar, trocar a tela, qualidade, números, quem assiste, prévia e tela cheia. */
const HostBar: React.FC<{ s: ScreenShareValue; lift: boolean }> = ({ s, lift }) => {
  const { stats } = s.host;
  const quality = s.screen?.quality ?? s.lastQuality;
  return (
    <div className={cx(barBase, glass, lift ? 'bottom-28' : 'bottom-6')}>
      <button type="button" onClick={s.stopBroadcast} className={cx(barBtn, 'gap-2 px-4 bg-lu-error/20 text-red-200 hover:!bg-lu-error/35 border border-lu-error/40')}>
        <MonitorOff size={17} />
        <span>{t('Parar de compartilhar')}</span>
      </button>
      <button type="button" aria-label={t('Trocar a tela')} onClick={() => void s.switchScreen()} className={cx(barBtn, 'group/sw px-3')}>
        <Repeat size={17} />
        <span className="max-w-0 ml-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 group-hover/sw:max-w-[120px] group-hover/sw:ml-2 group-hover/sw:opacity-100 group-focus-visible/sw:max-w-[120px] group-focus-visible/sw:ml-2 group-focus-visible/sw:opacity-100">
          {t('Trocar a tela')}
        </span>
      </button>
      <Divider />
      <QualityPicker current={quality} onPick={(id) => void s.changeQuality(screenQuality(id)!)} />
      {stats && <span className={cx(barInfo, 'max-md:hidden')}>{t('{fps} fps · {mbps} Mbps', { fps: stats.fps, mbps: fmt(stats.mbps) })}</span>}
      <ViewersChip viewers={s.viewers} />
      <FullscreenButton />
    </div>
  );
};

/** Liga/desliga a prévia (a imagem do player): fica no canto da imagem, fora da barra. */
const PreviewToggle: React.FC<{ s: ScreenShareValue }> = ({ s }) => (
  <button
    type="button"
    aria-label={s.host.showPreview ? t('Esconder a prévia') : t('Ver a prévia')}
    title={s.host.showPreview ? t('Esconder a prévia') : `${t('Ver a prévia')}. ${t('Se você compartilha a tela inteira, a prévia aparece dentro dela (efeito espelho).')}`}
    aria-pressed={s.host.showPreview}
    onClick={s.togglePreview}
    className={cx('absolute top-20 right-3 z-40 inline-flex items-center justify-center w-10 h-10 rounded-full text-lu-text hover:bg-white/15 transition-colors', glass)}
  >
    {s.host.showPreview ? <Eye size={18} /> : <EyeOff size={18} />}
  </button>
);

/** Barra de quem assiste: volume da transmissão, qualidade e números, tela cheia e "Voltar ao vídeo" (se a sala tem vídeo). */
const ViewerBar: React.FC<{ s: ScreenShareValue; lift: boolean }> = ({ s, lift }) => {
  const effective = s.muted ? 0 : s.volume;
  const Icon = effective === 0 ? VolumeX : effective < 0.5 ? Volume1 : Volume2;
  const percent = Math.round(effective * 100);
  return (
    <div className={cx(barBase, glass, lift ? 'bottom-28' : 'bottom-6')}>
      {/* Volume: o botão muta; ao passar o mouse (ou focar) abre o controle vertical com a porcentagem */}
      <div className="relative group/vol flex-none">
        <button type="button" aria-label={s.muted ? t('Ativar o som da transmissão') : t('Silenciar a transmissão')} onClick={s.toggleMuted} className={cx(barBtn, 'w-10')}>
          <Icon size={18} />
        </button>
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 pb-2 hidden group-hover/vol:block group-focus-within/vol:block">
          <div className={cx('flex flex-col items-center gap-2 rounded-full px-2 py-3', glass)}>
            <span className="text-[12px] tabular text-lu-text/90 w-9 text-center">{percent}%</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              aria-label={t('Volume da transmissão')}
              value={effective}
              onChange={(e) => s.setVolume(parseFloat(e.target.value))}
              style={{ writingMode: 'vertical-lr', direction: 'rtl', width: 20, height: 108 }}
              className="m-0 cursor-pointer"
            />
          </div>
        </div>
      </div>
      {s.screen && <span className={barInfo}>{resolutionLabel(s.screen.quality)}</span>}
      <FullscreenButton />
      {s.hasRoomMedia && (
        <>
          <Divider />
          <button type="button" onClick={s.returnToVideo} className={cx(barBtn, 'gap-2 px-3.5')}>
            <Film size={16} />
            <span>{t('Voltar ao vídeo')}</span>
          </button>
        </>
      )}
    </div>
  );
};

/**
 * Palco da transmissão, por cima do vídeo da sala (ou da tela "Nenhum vídeo"): a imagem (o canvas de quem assiste, a
 * prévia do Host), a barra de controles embaixo, o cartão "Assistir transmissão" e os avisos de conexão, erro e fim. O
 * vídeo da sala continua por baixo, mudo e sincronizado. `lift`: a sala tem a barra do player embaixo, então a nossa sobe.
 */
export const ScreenStage: React.FC<{ lift?: boolean }> = ({ lift = false }) => {
  const s = useScreenShare();
  const { status, error } = s.viewer;
  const hostLive = s.host.status === 'live';
  const available = s.canWatch && !s.isBroadcaster && Boolean(s.screen?.live);
  const errorText = s.host.error ?? (status === 'error' ? error : null);

  return (
    <>
      <canvas ref={s.attachCanvas} aria-hidden="true" className={cx('absolute inset-0 z-[5] w-full h-full bg-black object-contain', !s.covering && 'hidden')} />

      {hostLive && s.host.preview && s.host.showPreview && <HostPreviewBackdrop stream={s.host.preview} />}

      {s.covering && status === 'connecting' && (
        <div className="absolute inset-0 z-[6] flex items-center justify-center gap-3 text-[14px] pointer-events-none" role="status">
          <Spinner size={20} />
          <span>{t('Conectando à transmissão…')}</span>
        </div>
      )}

      {s.host.status === 'starting' && (
        <div className={cx(barBase, glass, 'bottom-6 px-4 py-2.5 text-[13px] gap-3')} role="status">
          <Spinner size={16} />
          <span>{t('Conectando à transmissão…')}</span>
        </div>
      )}
      {hostLive && <HostBar s={s} lift={lift} />}
      {hostLive && s.host.preview && <PreviewToggle s={s} />}
      {s.covering && <ViewerBar s={s} lift={lift} />}

      {available && !s.covering && status !== 'error' && (
        <div className={cx('absolute top-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-4 rounded-[16px] px-4 py-3 max-w-[calc(100%-32px)]', floatingCard)}>
          <Dot tone="error" pulse />
          <span className="text-[14px] font-medium">{t('O Host está transmitindo a tela')}</span>
          <PrimaryButton onClick={s.watch}>{t('Assistir transmissão')}</PrimaryButton>
        </div>
      )}

      {errorText && (
        <div className={cx('absolute top-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-[16px] px-4 py-3 max-w-[calc(100%-32px)]', floatingCard)} role="alert">
          <TriangleAlert size={18} className="text-lu-error flex-none" />
          <span className="text-[14px]">{errorText}</span>
          {available && status === 'error' && <GhostButton onClick={s.watch}>{t('Tentar de novo')}</GhostButton>}
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
