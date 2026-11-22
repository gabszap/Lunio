import React, { useEffect, useState } from 'react';
import { PanelRightClose, PanelRightOpen, Plus } from 'lucide-react';
import { formatRoomDuration } from '../../lib/roomDuration';
import { t } from '../../lib/i18n';
import { Dot, IconButton, Logo, cx } from '../ui';

interface RoomHeaderProps {
  roomCode: string;
  connected: boolean;
  environment: 'discord' | 'web';
  /** Timestamp (ms) de criação/entrada na sala para o cronômetro de duração. */
  createdAt: number;
  /** Função para ler o relógio atual (padrão Date.now; na Fase 2 usa ServerClock). */
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
 * - Centro da área principal: Nome/código da sala + cronômetro de duração
 * - Direita (alinhado com a barra lateral): campo único de URL + botão de recolher/abrir barra lateral
 */
export const RoomHeader: React.FC<RoomHeaderProps> = ({
  roomCode,
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

  return (
    <header className="flex-none relative z-30 flex flex-wrap items-center justify-between gap-2 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_360px] sm:gap-3 min-h-11">
      <div className="flex items-center justify-between gap-3 min-w-0 flex-1 sm:flex-initial">
        <Logo onClick={onLogoClick} size={28} />

        <div className="flex items-center gap-2.5 min-w-0 mx-auto">
          <Dot tone={connected ? (environment === 'discord' ? 'accent' : 'success') : 'muted'} />
          <span className="text-[14px] font-semibold truncate">
            {connected ? (
              environment === 'discord' ? (
                t('Canal de voz do Discord')
              ) : (
                <>
                  {t('Sala')} <span className="tracking-[0.1em] tabular">{roomCode}</span>
                </>
              )
            ) : (
              t('Modo Solo')
            )}
          </span>
          {connected && (
            <span
              aria-label={t('Duração da sala')}
              className="px-2 py-0.5 rounded-md bg-lu-bg2 border border-lu-border text-[12px] font-medium text-lu-muted tabular flex-none"
            >
              {formatRoomDuration(elapsedMs)}
            </span>
          )}
        </div>

        <div className="hidden lg:block w-8 flex-none" aria-hidden="true" />
      </div>

      <div className="flex items-center gap-2 min-w-0 w-full sm:w-auto">
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
          <form onSubmit={handleSubmit} className="relative flex-1 min-w-0">
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
    </header>
  );
};
