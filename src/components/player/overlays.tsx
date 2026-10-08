import { TriangleAlert, RefreshCw, Play, RotateCcw, X, FastForward, Film, Users, MessageSquare, Pause, Crown, Plus, ChevronLeft } from 'lucide-react';
import type { SubtitleTrack } from '../../types/media';
import { formatTime } from '../../lib/chapters';
import { Avatar, Dot, GhostButton, IconButton, Kbd, PrimaryButton, Spinner } from '../ui';
import { WatchPartyPanel } from '../WatchPartyPanel';
import { t } from '../../lib/i18n';

/** Peças visuais do player (avisos, prompts e toasts). Só renderizam: o estado e as decisões ficam nos hooks. */

const floatingCard =
  'bg-lu-surface/90 backdrop-blur-md border border-lu-border shadow-[0_16px_40px_rgba(0,0,0,0.45)]';

export function StandbyScreen(props: {
  canChoose: boolean;
  isConnected: boolean;
  membersCount: number;
  isWatchPartyOpen: boolean;
  onChooseVideo?: () => void;
  onToggleWatchParty: () => void;
  onCloseWatchParty: () => void;
  onOpenRoomLobby?: () => void;
  onLeaveRoom?: () => void;
}) {
  const { canChoose, isConnected, membersCount, isWatchPartyOpen, onChooseVideo, onToggleWatchParty, onCloseWatchParty, onOpenRoomLobby, onLeaveRoom } = props;
  return (
    <div
      id="video-player-standby"
      className="relative w-full aspect-video min-h-[320px] rounded-[18px] lu-video-bg border border-lu-border overflow-hidden flex items-center justify-center select-none"
    >
      <div className="flex flex-col items-center text-center gap-5 px-6">
        <div className="w-16 h-16 rounded-[14px] bg-lu-tint border border-lu-accent/30 flex items-center justify-center text-lu-accent">
          <Film size={28} />
        </div>
        <div>
          <h2 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">{t('Nenhum vídeo na sala')}</h2>
          <p className="mt-2 mx-auto mb-0 max-w-[420px] text-[14px] text-lu-muted">
            {canChoose || !isConnected
              ? t('Escolha um vídeo pra começar. Arquivo, YouTube, Drive ou link de stream.')
              : t('O Host ainda não escolheu o vídeo. Ele aparece aqui assim que for carregado.')}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          {canChoose && (
            <PrimaryButton onClick={onChooseVideo}>
              <Plus size={18} />
              <span>{t('Escolher um vídeo')}</span>
            </PrimaryButton>
          )}
          <GhostButton onClick={onToggleWatchParty}>
            <Users size={18} />
            <span>{t('Watch Party · {n} online', { n: Math.max(1, membersCount) })}</span>
          </GhostButton>
        </div>
      </div>

      <WatchPartyPanel isOpen={isWatchPartyOpen} onClose={onCloseWatchParty} onOpenRoomLobby={onOpenRoomLobby} onLeaveRoom={onLeaveRoom} />
    </div>
  );
}

export function SubtitlePreparingBadge({ label }: { label?: string }) {
  return (
    <div
      role="status"
      className={`absolute top-5 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2.5 px-4 py-2.5 rounded-[10px] text-[13px] font-medium whitespace-nowrap pointer-events-none ${floatingCard}`}
    >
      <Spinner size={16} className="text-lu-accent" />
      <span>
        {t('Sincronizando legenda')} <strong className="font-semibold text-lu-accent">{label}</strong>…
      </span>
    </div>
  );
}

export function SubtitleFailurePrompt({ prompt, hasNext, onTryNext, onWatchWithout }: { prompt: { track: SubtitleTrack; error: string; code?: string }; hasNext: boolean; onTryNext: () => void; onWatchWithout: () => void }) {
  return (
    <div id="subtitle-failure-prompt" className="absolute top-5 left-1/2 -translate-x-1/2 z-40 w-[92%] max-w-[440px] pointer-events-auto">
      <div role="alert" className={`rounded-[14px] p-4 flex flex-col gap-3 ${floatingCard} border-lu-error/30`}>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 flex-none rounded-[10px] bg-lu-error/12 border border-lu-error/30 flex items-center justify-center text-lu-error">
            <TriangleAlert size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">{t('Não deu pra carregar a legenda')}</div>
            <div className="text-[13px] text-lu-muted truncate">
              {prompt.track.label}
              {prompt.code ? ` · ${prompt.code}` : ''}
            </div>
            <p className="mt-1 mb-0 text-[12px] text-lu-muted">{prompt.error}</p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {hasNext && (
            <PrimaryButton onClick={onTryNext}>
              <RefreshCw size={16} />
              <span>{t('Tentar a próxima')}</span>
            </PrimaryButton>
          )}
          <GhostButton onClick={onWatchWithout}>{t('Assistir sem legenda')}</GhostButton>
        </div>
      </div>
    </div>
  );
}

export function PlaybackErrorOverlay({ error, onBack, onReconnect, onResetToWorkingPreset }: { error: { title: string; message: string; hint: string; code?: number }; onBack?: () => void; onReconnect: () => void; onResetToWorkingPreset?: () => void }) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-lu-video/92 backdrop-blur-md select-text">
      {onBack && (
        <div className="absolute top-5 left-4 sm:left-6">
          <IconButton label={t('Voltar')} onClick={onBack}>
            <ChevronLeft size={20} />
          </IconButton>
        </div>
      )}
      <div role="alert" className="flex flex-col items-center text-center gap-4 max-w-[460px] px-6">
        <div className="w-14 h-14 rounded-[14px] bg-lu-error/12 border border-lu-error/30 flex items-center justify-center text-lu-error">
          <TriangleAlert size={26} />
        </div>
        <h2 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">{error.title}</h2>
        <span className="inline-block px-3 py-1.5 rounded-md bg-lu-bg2 border border-lu-border font-mono text-[12px] text-lu-muted break-all">
          {error.message}
          {error.code ? ` (Code ${error.code})` : ''}
        </span>
        <p className="m-0 text-[14px] text-lu-muted">{error.hint}</p>
        <div className="flex flex-wrap justify-center gap-2 mt-1">
          <PrimaryButton onClick={onReconnect}>
            <RefreshCw size={18} />
            <span>{t('Reconectar stream')}</span>
          </PrimaryButton>
          {onResetToWorkingPreset && (
            <GhostButton onClick={onResetToWorkingPreset}>
              <Play size={18} />
              <span>{t('Preset Sintel 1080p')}</span>
            </GhostButton>
          )}
        </div>
      </div>
    </div>
  );
}

export function BufferingOverlay({ bufferAheadNow }: { bufferAheadNow: number }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none -mt-5">
      <div role="status" className={`flex items-center gap-3.5 px-5 py-3.5 rounded-[14px] ${floatingCard}`}>
        <Spinner size={22} className="text-lu-accent" />
        <div>
          <div className="text-[14px] font-semibold">{t('Carregando buffer da mídia…')}</div>
          <div className="text-[13px] tabular text-lu-muted">
            {t('Buffer acumulado: +{n} s', { n: bufferAheadNow.toFixed(1).replace('.', ',') })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function HostPausedOverlay({ pausedByName }: { pausedByName: string }) {
  return (
    <div id="host-paused-fixed-overlay" className="absolute inset-0 z-[35] flex items-center justify-center pointer-events-none px-4">
      <div role="status" className={`flex items-center gap-4 max-w-[440px] px-5 py-4 rounded-[14px] ${floatingCard}`}>
        <div className="w-11 h-11 flex-none rounded-[10px] bg-lu-tint text-lu-accent flex items-center justify-center">
          <Pause size={20} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[14px] font-semibold">
            <Crown size={14} className="flex-none" />
            <span className="truncate">{t('Vídeo pausado por {name}', { name: pausedByName })}</span>
          </div>
          <div className="mt-0.5 text-[13px] text-lu-muted">
            {t('A reprodução continuará automaticamente quando o Host der play.')}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ResumePrompt({ prompt, onResume, onDismiss }: { prompt: { time: number; formatted: string }; onResume: () => void; onDismiss: () => void }) {
  return (
    <div id="resume-playback-prompt" className="absolute bottom-[108px] left-3 sm:left-6 z-40 pointer-events-auto">
      <div className={`flex items-center gap-3 p-2.5 pl-3 rounded-[14px] ${floatingCard}`}>
        <span className="w-9 h-9 flex-none rounded-[10px] bg-lu-tint text-lu-accent flex items-center justify-center">
          <RotateCcw size={16} />
        </span>
        <div className="min-w-0">
          <div className="text-[12px] text-lu-muted">{t('Continuar de onde parou?')}</div>
          <div className="text-[14px] font-semibold tabular">{prompt.formatted}</div>
        </div>
        <PrimaryButton onClick={onResume} className="!h-9 !px-3.5 text-[13px]">
          {t('Retomar')}
        </PrimaryButton>
        <IconButton label={t('Fechar e assistir do início')} size={36} tone="muted" onClick={onDismiss}>
          <X size={16} />
        </IconButton>
      </div>
    </div>
  );
}

export function SkipChapterButton({ chapter, showControls, skipProgress, onSkip }: { chapter: { targetTime: number; label: string }; showControls: boolean; skipProgress: number; onSkip: () => void }) {
  return (
    <button
      id="skip-chapter-prompt"
      type="button"
      aria-label={`${chapter.label} (N)`}
      title={t('{label}: avançar para {v1}', { label: chapter.label, v1: formatTime(chapter.targetTime) })}
      onClick={(e) => {
            e.stopPropagation();
            onSkip();
          }}
      className={`absolute z-40 inline-flex items-center gap-2.5 h-12 px-4 rounded-[10px] overflow-hidden bg-lu-surface/84 backdrop-blur-md border border-white/14 text-[14px] font-semibold hover:bg-lu-elevated transition-[bottom,right,background-color] duration-200 ${
        showControls ? 'right-3 sm:right-6 bottom-[108px]' : 'right-4 sm:right-8 bottom-6 sm:bottom-8'
      }`}
    >
      <FastForward size={18} />
      <span>{chapter.label}</span>
      <span className="hidden sm:inline-flex">
        <Kbd>N</Kbd>
      </span>
      <span className="absolute left-0 bottom-0 h-0.5 bg-lu-accent" style={{ width: `${skipProgress}%` }} />
    </button>
  );
}

export function PlayerToasts({ osdToast, aspectToast, syncToast }: { osdToast: { text: string } | null; aspectToast: string | null; syncToast: string | null }) {
  return (
    <div className="absolute top-[84px] left-1/2 -translate-x-1/2 z-[45] flex flex-col items-center gap-2 pointer-events-none">
      {(osdToast || aspectToast) && (
        <div
          id="player-sync-osd-toast"
          role="status"
          className="flex items-center gap-2.5 px-4 py-2.5 rounded-[10px] bg-lu-elevated/94 backdrop-blur-md border border-lu-border shadow-[0_8px_24px_rgba(0,0,0,0.45)] text-[13px] font-medium tabular whitespace-nowrap"
        >
          <Dot tone="accent" />
          {osdToast ? osdToast.text : aspectToast}
        </div>
      )}
      {syncToast && (
        <div
          role="status"
          className="flex items-center gap-2.5 px-4 py-2.5 rounded-[10px] bg-lu-elevated/94 backdrop-blur-md border border-lu-border shadow-[0_8px_24px_rgba(0,0,0,0.45)] text-[13px] font-medium whitespace-nowrap"
        >
          <Dot tone="accent" />
          {syncToast}
        </div>
      )}
    </div>
  );
}

export function ChatToasts({ toasts, onOpen }: { toasts: Array<{ id: string; username: string; text: string; avatarUrl?: string }>; onOpen: () => void }) {
  return (
    <div className="absolute top-16 right-4 sm:right-6 z-40 flex flex-col gap-2 pointer-events-none w-[300px] max-w-[calc(100%-32px)]">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={onOpen}
          className={`flex items-center gap-3 p-3 rounded-[14px] text-left pointer-events-auto hover:bg-lu-elevated transition-colors ${floatingCard}`}
        >
          <Avatar name={toast.username} url={toast.avatarUrl} size={32} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[12px] text-lu-muted">
              <MessageSquare size={12} />
              {toast.username}
            </span>
            <span className="block text-[14px] truncate">{toast.text}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function RoundedCornersFrame() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[45] hidden sm:block rounded-[18px] border border-lu-border shadow-[0_0_0_24px_var(--color-lu-bg)]"
    />
  );
}

