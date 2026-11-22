import React, { useRef, useState } from 'react';
import { Check, ChevronUp, Clock, Film, Keyboard, Link2, LogOut, Share2, Terminal, Users } from 'lucide-react';
import { formatTime } from '../../lib/chapters';
import { t, msg } from '../../lib/i18n';
import { syncManager } from '../../lib/sync';
import { ScreenShareControl } from '../player/ScreenShare';
import { Kbd, cx, useDismiss } from '../ui';

const SHORTCUTS: Array<{ group: string; items: Array<{ label: string; keys: string[]; accent?: boolean }> }> = [
  {
    group: msg('Reprodução'),
    items: [
      { label: msg('Play / Pause'), keys: [msg('Espaço'), 'K'] },
      { label: msg('Voltar 10 s'), keys: ['J', '←'] },
      { label: msg('Avançar 10 s'), keys: ['L', '→'] },
      { label: msg('Pular abertura (+90 s)'), keys: ['N', 'O'], accent: true },
    ],
  },
  {
    group: msg('Áudio e legendas'),
    items: [
      { label: msg('Volume ±5%'), keys: ['↑', '↓'] },
      { label: 'Silenciar', keys: ['M'] },
      { label: msg('Alternar legendas'), keys: ['C'] },
      { label: msg('Sincronia da legenda ±50 ms'), keys: ['G', 'H'] },
      { label: msg('Atraso do áudio ±50 ms'), keys: ['[', ']'] },
    ],
  },
  {
    group: 'Vídeo',
    items: [
      { label: msg('Ajuste de tela'), keys: ['Z'] },
      { label: msg('Tela cheia'), keys: ['F'] },
      { label: 'Watch Party', keys: ['W'] },
    ],
  },
];

export interface RoomDockProps {
  connected: boolean;
  isHost: boolean;
  environment: 'discord' | 'web';
  roomCode: string;
  /** Em tela cheia a dock fica recolhida fora da tela e sobe suavemente ao passar o mouse na borda inferior. */
  isFullscreen?: boolean;
  onOpenMediaPicker: () => void;
  onOpenRoomLobby: () => void;
  onLeaveRoom: () => void;
  onOpenLogs: () => void;
  screenOpen: boolean;
  onScreenOpenChange: (open: boolean) => void;
}

const dockBtnBase =
  'inline-flex items-center justify-center gap-2 h-9 px-3 rounded-[9px] text-[13px] font-medium transition-colors whitespace-nowrap flex-none';

export const RoomDock: React.FC<RoomDockProps> = ({
  connected,
  isHost,
  environment,
  roomCode,
  isFullscreen = false,
  onOpenMediaPicker,
  onOpenRoomLobby,
  onLeaveRoom,
  onOpenLogs,
  screenOpen,
  onScreenOpenChange,
}) => {
  const [shareOpen, setShareOpen] = useState(false);
  const [shareAt, setShareAt] = useState(0);
  const [copiedLink, setCopiedLink] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  const shareRef = useRef<HTMLDivElement>(null);
  const shortcutsRef = useRef<HTMLDivElement>(null);
  useDismiss(shareOpen, () => setShareOpen(false), shareRef);
  useDismiss(shortcutsOpen, () => setShortcutsOpen(false), shortcutsRef);

  const canChooseMedia = !connected || isHost;
  const anyMenuOpen = shareOpen || shortcutsOpen || screenOpen;
  const revealDock = !isFullscreen || hovered || anyMenuOpen;

  const copyRoomLink = (atSeconds?: number) => {
    const url = new URL('/', window.location.origin);
    url.searchParams.set('room', roomCode);
    if (atSeconds === undefined) url.searchParams.delete('t');
    else url.searchParams.set('t', String(Math.floor(atSeconds)));
    navigator.clipboard.writeText(url.toString()).catch(() => {});
    setShareOpen(false);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const pill = (
    <div
      id="room-dock"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cx(
        'inline-flex items-center gap-1.5 p-1.5 rounded-[14px] bg-lu-bg2/94 backdrop-blur-md border border-lu-border-strong shadow-[0_12px_32px_rgba(0,0,0,0.45)] max-w-full',
        isFullscreen && 'transition-all duration-200',
        isFullscreen && (revealDock ? 'translate-y-0 opacity-100 pointer-events-auto' : 'translate-y-[calc(100%+20px)] opacity-0 pointer-events-none')
      )}
    >
      {canChooseMedia && (
        <button
          id="btn-dock-choose-media"
          type="button"
          onClick={onOpenMediaPicker}
          className={cx(dockBtnBase, 'bg-lu-tint text-lu-accent hover:bg-lu-accent/20 font-semibold')}
        >
          <Film size={16} />
          <span className="hidden sm:inline">{t('Escolher vídeo')}</span>
        </button>
      )}

      <ScreenShareControl open={screenOpen} onOpenChange={onScreenOpenChange} variant="dock" />

      {connected && environment !== 'discord' && (
        <div ref={shareRef} className="relative">
          <button
            id="btn-dock-share"
            type="button"
            aria-haspopup="menu"
            aria-expanded={shareOpen}
            onClick={() => {
              if (!shareOpen) setShareAt(syncManager.getPlayheadSeconds());
              setShareOpen((o) => !o);
            }}
            className={cx(
              dockBtnBase,
              shareOpen ? 'bg-white/12 text-lu-text' : 'bg-white/6 text-lu-text hover:bg-white/10'
            )}
          >
            {copiedLink ? <Check size={15} className="text-lu-success" /> : <Share2 size={15} />}
            <span className="hidden md:inline">{copiedLink ? t('Link copiado') : t('Compartilhar')}</span>
            {!copiedLink && <ChevronUp size={13} className={cx('hidden md:inline transition-transform', !shareOpen && 'rotate-180')} />}
          </button>

          {shareOpen && (
            <div
              role="menu"
              className="absolute left-1/2 -translate-x-1/2 bottom-[calc(100%+10px)] z-50 w-[250px] p-1.5 rounded-[12px] bg-lu-elevated border border-lu-border shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => copyRoomLink()}
                className="w-full h-10 px-2.5 rounded-[10px] flex items-center gap-3 text-[14px] text-left text-lu-text bg-transparent hover:bg-white/6 border-0"
              >
                <Link2 size={16} className="flex-none text-lu-muted" />
                <span className="truncate">{t('Link da sala')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => copyRoomLink(shareAt)}
                className="w-full h-10 px-2.5 rounded-[10px] flex items-center gap-3 text-[14px] text-left text-lu-text bg-transparent hover:bg-white/6 border-0"
              >
                <Clock size={16} className="flex-none text-lu-muted" />
                <span className="truncate">{t('Link neste instante ({time})', { time: formatTime(shareAt) })}</span>
              </button>
            </div>
          )}
        </div>
      )}

      <span className="w-px h-5 bg-lu-border mx-0.5 flex-none" aria-hidden="true" />

      <div ref={shortcutsRef} className="relative hidden sm:block">
        <button
          id="btn-dock-shortcuts"
          type="button"
          aria-label={t('Atalhos do teclado')}
          title={t('Atalhos do teclado')}
          aria-expanded={shortcutsOpen}
          onClick={() => setShortcutsOpen((v) => !v)}
          className={cx(
            dockBtnBase,
            shortcutsOpen ? 'bg-lu-tint text-lu-accent' : 'bg-white/6 text-lu-muted hover:text-lu-text hover:bg-white/10'
          )}
        >
          <Keyboard size={16} />
          <span className="hidden xl:inline">{t('Atalhos')}</span>
        </button>

        {shortcutsOpen && (
          <div
            role="dialog"
            aria-label={t('Atalhos do teclado')}
            className="absolute left-1/2 -translate-x-1/2 bottom-[calc(100%+10px)] z-50 w-[420px] max-w-[calc(100vw-32px)] box-border p-2.5 rounded-[14px] bg-lu-elevated border border-lu-border shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
          >
            <div className="px-2.5 pt-2 pb-1 text-[14px] font-semibold">{t('Atalhos do teclado')}</div>
            {SHORTCUTS.map((section, i) => (
              <React.Fragment key={section.group}>
                {i > 0 && <div className="h-px bg-lu-border mx-2.5" />}
                <div className="py-1.5">
                  <div className="px-2.5 py-1.5 text-[12px] font-medium text-lu-muted">{t(section.group)}</div>
                  {section.items.map((item) => (
                    <div key={item.label} className="flex items-center justify-between gap-4 h-9 px-2.5">
                      <span className={cx('text-[14px]', item.accent ? 'text-lu-accent' : 'text-lu-text')}>{t(item.label)}</span>
                      <span className="flex gap-1">
                        {item.keys.map((k) => (
                          <Kbd key={k}>{t(k)}</Kbd>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </React.Fragment>
            ))}
          </div>
        )}
      </div>

      <button
        id="btn-dock-logs"
        type="button"
        aria-label={t('Console do player')}
        title={t('Console do player')}
        onClick={onOpenLogs}
        className={cx(dockBtnBase, 'bg-white/6 text-lu-muted hover:text-lu-text hover:bg-white/10')}
      >
        <Terminal size={16} />
        <span className="hidden lg:inline">{t('Logs')}</span>
      </button>

      <span className="w-px h-5 bg-lu-border mx-0.5 flex-none" aria-hidden="true" />

      {connected ? (
        <button
          id="btn-dock-leave"
          type="button"
          onClick={() => {
            if (window.confirm(t('Sair desta sala e voltar para a tela inicial?'))) {
              onLeaveRoom();
            }
          }}
          className={cx(dockBtnBase, 'bg-lu-error/90 hover:bg-lu-error text-white font-semibold')}
        >
          <LogOut size={15} />
          <span>{t('Sair')}</span>
        </button>
      ) : (
        <button
          id="btn-dock-lobby"
          type="button"
          onClick={onOpenRoomLobby}
          className={cx(dockBtnBase, 'bg-lu-accent text-lu-bg hover:bg-lu-accent-hover font-semibold')}
        >
          <Users size={15} />
          <span>{t('Criar ou entrar em sala')}</span>
        </button>
      )}
    </div>
  );

  if (isFullscreen) {
    return (
      <>
        {!revealDock && (
          <div
            aria-hidden="true"
            onMouseEnter={() => setHovered(true)}
            className="fixed inset-x-0 bottom-0 h-2 z-40 pointer-events-auto"
          />
        )}
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-end justify-center pointer-events-none">
          <div
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            className={cx('pb-3 px-2', revealDock ? 'pointer-events-auto' : 'pointer-events-none')}
          >
            {pill}
          </div>
        </div>
      </>
    );
  }

  return <div className="flex-none relative z-40 flex items-center justify-center">{pill}</div>;
};
