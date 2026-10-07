import React, { useRef, useState } from 'react';
import { Check, Keyboard, Share2, Users } from 'lucide-react';
import { formatRoomUrl } from '../lib/roomCode';
import { copyText } from '../lib/recent';
import { Dot, IconButton, Kbd, Logo, cx, useDismiss } from './ui';
import { t, msg } from '../lib/i18n';

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

const ShortcutsMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  return (
    <div ref={ref} className="relative hidden sm:block">
      <IconButton label={t('Atalhos do teclado')} size={40} tone="muted" active={open} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Keyboard size={18} />
      </IconButton>
      {open && (
        <div
          role="dialog"
          aria-label={t('Atalhos do teclado')}
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-[440px] max-w-[calc(100vw-32px)] box-border p-2.5 rounded-[14px] bg-lu-elevated border border-lu-border shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
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
  );
};

interface PlayerPageProps {
  onHome: () => void;
  room: { connected: boolean; code: string; members: number };
  environment: 'discord' | 'web';
  unreadChat: number;
  onToggleWatchParty: () => void;
  children: React.ReactNode;
  console: React.ReactNode;
}

export const PlayerPage: React.FC<PlayerPageProps> = ({ onHome, room, environment, unreadChat, onToggleWatchParty, children, console }) => {
  const [copied, setCopied] = useState(false);

  const shareRoom = async () => {
    if (await copyText(formatRoomUrl(room.code))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-lu-bg flex flex-col">
      <header className="sticky top-0 z-40 h-16 box-border grid grid-cols-[1fr_auto] md:grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 sm:px-8 border-b border-lu-border bg-lu-bg">
        <Logo onClick={onHome} />

        {/* Coluna central com laterais 1fr iguais: o card da sala fica centralizado na página */}
        <div className="min-w-0 hidden md:flex justify-center">
          {room.connected && (
            <div className="flex items-center gap-3 h-11 pl-4 pr-1.5 box-border rounded-[10px] bg-lu-surface border border-lu-border">
              <span className="text-[12px] text-lu-muted">{t('Sala')}</span>
              <span className="text-[14px] font-semibold tracking-[0.14em] tabular">{room.code}</span>
              <button
                type="button"
                onClick={shareRoom}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-lu-tint text-lu-accent text-[13px] font-semibold hover:bg-lu-accent/20"
              >
                {copied ? <Check size={14} /> : <Share2 size={14} />}
                {copied ? t('Link copiado') : 'Compartilhar'}
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 flex-none">
          <span className="hidden md:inline-flex items-center gap-2 text-[13px] text-lu-muted">
            <Dot tone={environment === 'discord' ? 'accent' : 'success'} />
            {environment === 'discord' ? 'Discord Activity' : 'Web Standalone'}
          </span>
          <ShortcutsMenu />
          <button
            type="button"
            onClick={onToggleWatchParty}
            aria-label={`${t('Watch Party')}${room.connected ? t(', {n} na sala', { n: room.members }) : ''}${unreadChat ? t(', {n} mensagens novas', { n: unreadChat }) : ''}`}
            className={cx(
              'relative inline-flex items-center gap-2 h-10 px-3.5 rounded-[10px] text-[13px] font-semibold border transition-colors',
              room.connected
                ? 'bg-lu-tint border-lu-accent/30 text-lu-accent hover:bg-lu-accent/20'
                : 'bg-lu-surface border-lu-border text-lu-text hover:bg-lu-elevated'
            )}
          >
            <Users size={16} />
            <span className="hidden sm:inline">{t('Watch Party')}</span>
            {room.connected && <span className="text-[12px] tabular">{room.members}</span>}
            {unreadChat > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 box-border rounded-full bg-lu-error text-lu-bg text-[10px] font-bold leading-[18px] text-center">
                {unreadChat > 9 ? '9+' : unreadChat}
              </span>
            )}
          </button>
        </div>
      </header>

      <main className="w-full max-w-[1320px] mx-auto px-0 sm:px-8 pt-0 sm:pt-6 pb-14 box-border flex flex-col gap-5">
        {children}
        <div className="px-4 sm:px-0">{console}</div>
      </main>
    </div>
  );
};
