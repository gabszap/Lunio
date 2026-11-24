import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, Keyboard, Lock, PanelRightClose, PanelRightOpen, Plus } from 'lucide-react';
import { formatRoomDuration } from '../../lib/roomDuration';
import { copyText } from '../../lib/recent';
import { t, msg } from '../../lib/i18n';
import type { RoomVisibility } from '../../types/sync';
import { Dot, IconButton, Kbd, Logo, cx, useDismiss } from '../ui';

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

interface RoomHeaderProps {
  roomCode: string;
  roomName?: string;
  visibility?: RoomVisibility;
  connected: boolean;
  environment: 'discord' | 'web';
  /** Timestamp (ms) de criação/entrada na sala para o cronômetro de duração. */
  createdAt: number;
  /** Função para ler o relógio atual (padrão Date.now; usa ServerClock). */
  now?: () => number;
  isHost: boolean;
  sidebarOpen: boolean;
  unreadChat: number;
  onLogoClick: () => void;
  onToggleSidebar: () => void;
  /** Envia o link digitado no campo superior; retorna mensagem de erro ou null se aceito. */
  onSubmitUrl: (raw: string) => Promise<string | null>;
}

/**
 * Cabeçalho limpo da sala:
 * - Esquerda: Logo (com confirmação de saída se conectado)
 * - Centro real do palco (ou da tela inteira quando a barra lateral está recolhida): Sala + cronômetro
 * - Direita: Atalhos + recolher/abrir barra lateral + campo único de URL
 */
export const RoomHeader: React.FC<RoomHeaderProps> = ({
  roomCode,
  roomName,
  visibility = 'public',
  connected,
  environment,
  createdAt,
  now = Date.now,
  isHost,
  sidebarOpen,
  unreadChat,
  onLogoClick,
  onToggleSidebar,
  onSubmitUrl,
}) => {
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, now() - createdAt));
  const [copiedCode, setCopiedCode] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutsRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<number | null>(null);
  useDismiss(shortcutsOpen, () => setShortcutsOpen(false), shortcutsRef);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleCopyCode = async () => {
    if (!roomCode) return;
    if (await copyText(roomCode)) {
      setCopiedCode(true);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopiedCode(false);
      }, 1800);
    }
  };

  useEffect(() => {
    const tick = () => setElapsedMs(Math.max(0, now() - createdAt));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [createdAt, now]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setUrlError('');
    try {
      const err = await onSubmitUrl(trimmed);
      if (err) {
        setUrlError(err);
      } else {
        setUrlInput('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const urlAriaLabel = isHost ? t('Link para adicionar à fila') : t('Sugerir link para a sala');
  const submitAriaLabel = isHost ? t('Adicionar à fila') : t('Enviar pedido');
  const urlPlaceholder = isHost ? t('Colar link de vídeo ou YouTube…') : t('Sugerir link de vídeo ou YouTube…');

  const roomPill = (
    <div className="flex items-center justify-center gap-2 min-w-0">
      <Dot tone={connected ? (environment === 'discord' ? 'accent' : 'success') : 'muted'} />
      {connected ? (
        environment === 'discord' ? (
          <span className="text-[14px] font-semibold truncate">{t('Canal de voz do Discord')}</span>
        ) : (
          <div className="inline-flex items-center gap-1.5 min-w-0">
            {visibility === 'private' && (
              <span title={t('Sala privada')} aria-label={t('Sala privada')} className="text-lu-accent flex-none inline-flex">
                <Lock size={13} />
              </span>
            )}
            <span className="text-[13px] font-semibold text-lu-text max-w-[180px] truncate">
              {roomName || t('Sessão')}
            </span>
            <button
              id="btn-room-code-copy"
              type="button"
              onClick={handleCopyCode}
              title={t('Copiar código da sala')}
              aria-label={t('Copiar código da sala')}
              className={cx(
                'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[13px] font-semibold tracking-[0.09em] tabular transition-colors',
                copiedCode
                  ? 'bg-lu-success/12 border-lu-success/35 text-lu-success'
                  : 'bg-lu-bg2 border-lu-border text-lu-text hover:bg-lu-surface hover:border-lu-border-strong'
              )}
            >
              <span>{copiedCode ? t('Copiado') : roomCode}</span>
              {copiedCode ? <Check size={13} /> : <Copy size={13} className="text-lu-muted" />}
            </button>
          </div>
        )
      ) : (
        <span className="text-[14px] font-semibold truncate">{t('Modo Solo')}</span>
      )}
      {connected && (
        <span
          aria-label={t('Duração da sala')}
          className="px-2 py-0.5 rounded-md bg-lu-bg2 border border-lu-border text-[12px] font-medium text-lu-muted tabular flex-none"
        >
          {formatRoomDuration(elapsedMs)}
        </span>
      )}
    </div>
  );

  const rightControls = (
    <div className="flex items-center justify-end gap-2 min-w-0 w-full sm:w-auto">
      <div ref={shortcutsRef} className="relative hidden sm:block">
        <IconButton
          id="btn-header-shortcuts"
          label={t('Atalhos do teclado')}
          size={40}
          tone="muted"
          active={shortcutsOpen}
          aria-expanded={shortcutsOpen}
          onClick={() => setShortcutsOpen((v) => !v)}
          className="border border-lu-border bg-lu-bg2"
        >
          <Keyboard size={18} />
        </IconButton>

        {shortcutsOpen && (
          <div
            role="dialog"
            aria-label={t('Atalhos do teclado')}
            className="absolute right-0 top-[calc(100%+8px)] z-50 w-[420px] max-w-[calc(100vw-32px)] max-h-[min(75dvh,560px)] overflow-y-auto custom-scrollbar box-border p-2.5 rounded-[14px] bg-lu-elevated border border-lu-border shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
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

      <IconButton
        label={sidebarOpen ? t('Recolher barra lateral') : t('Abrir barra lateral')}
        size={40}
        tone="muted"
        active={sidebarOpen}
        aria-pressed={sidebarOpen}
        onClick={onToggleSidebar}
        className="border border-lu-border bg-lu-bg2"
      >
        {sidebarOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        {!sidebarOpen && unreadChat > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 box-border rounded-full bg-lu-error text-lu-bg text-[10px] font-bold leading-[18px] text-center">
            {unreadChat > 9 ? '9+' : unreadChat}
          </span>
        )}
      </IconButton>

      {connected && (
        <form onSubmit={handleSubmit} className="relative flex-1 min-w-0 sm:w-[280px] sm:flex-none lg:w-[360px]">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => {
              setUrlInput(e.target.value);
              if (urlError) setUrlError('');
            }}
            aria-label={urlAriaLabel}
            placeholder={urlPlaceholder}
            className={cx(
              'w-full h-10 box-border pl-3.5 pr-11 rounded-[10px] bg-lu-bg2 border text-lu-text font-[inherit] text-[13px] transition-colors',
              urlError
                ? 'border-lu-error focus:border-lu-error'
                : 'border-lu-border hover:border-lu-border-strong focus:border-lu-accent/60 focus-visible:outline-none'
            )}
          />
          <button
            type="submit"
            disabled={!urlInput.trim() || submitting}
            aria-label={submitAriaLabel}
            title={submitAriaLabel}
            className="absolute right-1 top-1 w-8 h-8 rounded-[7px] inline-flex items-center justify-center bg-lu-accent text-lu-bg hover:bg-lu-accent-hover disabled:opacity-40 transition-colors"
          >
            <Plus size={16} strokeWidth={2.2} />
          </button>
          {urlError && (
            <div
              role="alert"
              className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 px-3 py-2 rounded-[10px] bg-lu-elevated border border-lu-error/40 text-[12px] text-lu-error shadow-[0_12px_28px_rgba(0,0,0,0.45)]"
            >
              {urlError}
            </div>
          )}
        </form>
      )}
    </div>
  );

  // Centraliza a pílula da sessão exatamente no meio do cabeçalho (sem pular ao abrir/fechar a barra lateral).
  return (
    <header className="flex-none relative z-30 flex flex-wrap items-center justify-between gap-2 min-h-11">
      <div className="flex-none">
        <Logo onClick={onLogoClick} size={28} />
      </div>

      <div className="md:absolute md:left-1/2 md:-translate-x-1/2 md:pointer-events-auto">
        {roomPill}
      </div>

      <div className="w-full sm:w-auto flex-none">{rightControls}</div>
    </header>
  );
};
