import React, { Suspense, lazy, useEffect, useState } from 'react';
import { ChevronLeft, Compass, FolderOpen, Link, Upload, X, Youtube } from 'lucide-react';
import { StreamStep } from '../home/StreamStep';
import { UploadStep } from '../home/UploadStep';
import { DriveStep, YouTubeStep } from '../home/LinkSourceSteps';
import type { SourceStep } from '../home/RoomMenu';
import type { CommitMode, CommitOptions, SourceCommit } from '../home/types';
import type { WatchIntent } from '../catalog/CatalogTab';
import type { RecentStream } from '../../lib/recent';
import type { StreamOption } from '../../lib/streams';
import type { CatalogSeriesContext, MediaPayload } from '../../types/media';
import type { CatalogRef } from '../../lib/continueWatching';
import { t, msg } from '../../lib/i18n';
import { Dot, IconButton, PillTabs, Spinner, cx } from '../ui';

const CatalogTab = lazy(() => import('../catalog/CatalogTab').then((m) => ({ default: m.CatalogTab })));

export type PickerTab = 'catalog' | 'stream' | 'upload' | 'youtube' | 'drive';

interface MediaPickerModalProps {
  open: boolean;
  onClose: () => void;
  inRoom?: boolean;
  roomCode?: string;
  initialTab?: PickerTab;
  recentStreams: RecentStream[];
  onRemoveRecent: (url: string) => void;
  onClearRecent: () => void;
  pendingSubtitles: number;
  onAddSubtitle: () => void;
  ensureRoom: () => string;
  requireName: (then: () => void) => void;
  onCommit: SourceCommit;
  onPlayStream: (
    stream: StreamOption,
    title: string,
    seriesContext?: CatalogSeriesContext,
    movie?: CatalogRef
  ) => void;
}

const TABS: Array<{ value: PickerTab; label: string; icon: React.ReactNode }> = [
  { value: 'catalog', label: msg('Catálogo'), icon: <Compass size={16} /> },
  { value: 'stream', label: msg('Link de stream'), icon: <Link size={16} /> },
  { value: 'upload', label: msg('Enviar um arquivo'), icon: <Upload size={16} /> },
  { value: 'youtube', label: 'YouTube', icon: <Youtube size={16} /> },
  { value: 'drive', label: 'Google Drive', icon: <FolderOpen size={16} /> },
];

const MediaPickerPage: React.FC<Omit<MediaPickerModalProps, 'open'>> = ({
  onClose,
  inRoom,
  roomCode,
  initialTab = 'catalog',
  recentStreams,
  onRemoveRecent,
  onClearRecent,
  pendingSubtitles,
  onAddSubtitle,
  ensureRoom,
  requireName,
  onCommit,
  onPlayStream,
}) => {
  const [tab, setTab] = useState<PickerTab>(initialTab);
  const [watchIntent, setWatchIntent] = useState<WatchIntent | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Só fecha a tela cheia do catálogo se não houver um modal aberto por cima (ex.: AddonsPanel ou SubtitleModal)
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCommit = (
    payload: MediaPayload,
    mode: CommitMode,
    options?: CommitOptions
  ) => {
    onCommit(payload, inRoom ? 'room' : mode, options);
    setWatchIntent(null);
    onClose();
  };

  const handlePlayStream = (
    stream: StreamOption,
    title: string,
    seriesContext?: CatalogSeriesContext,
    movie?: CatalogRef
  ) => {
    onPlayStream(stream, title, seriesContext, movie);
    setWatchIntent(null);
    onClose();
  };

  const handlePickStep = (step: SourceStep) => {
    if (step === 'stream' || step === 'upload' || step === 'youtube' || step === 'drive') {
      setTab(step);
    }
  };

  return (
    <div
      aria-label={t('Escolher vídeo')}
      className={cx(
        'fixed inset-0 z-[90] overflow-y-auto flex flex-col text-lu-text',
        tab === 'catalog' ? 'lu-catalog-bg' : 'lu-home-bg'
      )}
    >
      <header className="sticky top-0 z-20 grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_1fr] items-center gap-y-3 px-4 sm:px-8 py-3 sm:py-0 sm:h-20 bg-lu-bg/85 backdrop-blur-md border-b border-lu-border">
        <div className="flex items-center gap-2.5 min-w-0 justify-self-start">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 h-10 pl-2.5 pr-3.5 rounded-[10px] bg-lu-surface border border-lu-border text-[13.5px] font-semibold text-lu-text hover:bg-lu-elevated hover:border-lu-border-strong transition-colors whitespace-nowrap"
          >
            <ChevronLeft size={17} />
            <span>{t('Voltar para a sala')}</span>
          </button>
          {inRoom && roomCode && (
            <span className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-lu-bg2 border border-lu-border text-[12px] font-semibold text-lu-muted tabular">
              <Dot tone="success" />
              {t('Sala')} <span className="tracking-[0.08em] text-lu-text">{roomCode}</span>
            </span>
          )}
        </div>

        <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto overflow-x-auto no-scrollbar max-w-full">
          <PillTabs
            value={tab}
            onChange={(next) => {
              setTab(next);
              setWatchIntent(null);
            }}
            size="sm"
            label={t('Fonte do vídeo')}
            options={TABS}
          />
        </div>

        <div className="flex items-center justify-end col-start-2 row-start-1 sm:col-start-3">
          <IconButton label={t('Voltar para a sala')} size={40} tone="muted" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </div>
      </header>

      <main
        className={cx(
          'relative flex-1 flex flex-col',
          tab === 'catalog'
            ? 'px-4 sm:px-12 pt-6 pb-16'
            : 'items-center justify-center gap-7 px-4 sm:px-8 pt-6 pb-12'
        )}
      >
        {tab === 'catalog' && (
          <Suspense
            fallback={
              <div role="status" aria-label={t('Carregando')} className="w-full min-h-[360px] flex items-center justify-center">
                <Spinner size={28} className="text-lu-accent" />
              </div>
            }
          >
            <CatalogTab
              syncUrl={false}
              onWatch={(intent) => {
                setWatchIntent(intent);
                setTab('stream');
              }}
              onPlayStream={handlePlayStream}
              onCreateRoom={() => setTab('stream')}
            />
          </Suspense>
        )}

        {tab === 'stream' && (
          <StreamStep
            recentStreams={recentStreams}
            onRemoveRecent={onRemoveRecent}
            onClearRecent={onClearRecent}
            intentTitle={watchIntent?.title}
            preferSolo={watchIntent?.preferSolo}
            inRoom={inRoom}
            pendingSubtitles={pendingSubtitles}
            onAddSubtitle={onAddSubtitle}
            onBack={() => (watchIntent ? setTab('catalog') : onClose())}
            onCommit={handleCommit}
          />
        )}

        {tab === 'upload' && (
          <UploadStep
            onBack={onClose}
            onCommit={handleCommit}
            ensureRoom={ensureRoom}
            requireName={requireName}
            onPickSource={handlePickStep}
          />
        )}

        {tab === 'youtube' && <YouTubeStep onBack={onClose} onCommit={handleCommit} inRoom={inRoom} />}

        {tab === 'drive' && <DriveStep onBack={onClose} onCommit={handleCommit} inRoom={inRoom} />}
      </main>
    </div>
  );
};

/**
 * Tela inteira do Catálogo / fontes de mídia aberta por cima da sala, preservando a conexão e o player vivos por baixo.
 */
export const MediaPickerModal: React.FC<MediaPickerModalProps> = ({ open, ...rest }) => {
  if (!open) return null;
  return <MediaPickerPage {...rest} />;
};
