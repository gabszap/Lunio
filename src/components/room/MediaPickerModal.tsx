import React, { Suspense, lazy, useState } from 'react';
import { Compass, FolderOpen, Link, Upload, Youtube } from 'lucide-react';
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
import { Modal, ModalHeader, PillTabs, Spinner } from '../ui';

const CatalogTab = lazy(() => import('../catalog/CatalogTab').then((m) => ({ default: m.CatalogTab })));

export type PickerTab = 'catalog' | 'stream' | 'upload' | 'youtube' | 'drive';

interface MediaPickerModalProps {
  open: boolean;
  onClose: () => void;
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
  { value: 'catalog', label: msg('Catálogo'), icon: <Compass size={15} /> },
  { value: 'stream', label: msg('Link de stream'), icon: <Link size={15} /> },
  { value: 'upload', label: msg('Enviar um arquivo'), icon: <Upload size={15} /> },
  { value: 'youtube', label: 'YouTube', icon: <Youtube size={15} /> },
  { value: 'drive', label: 'Google Drive', icon: <FolderOpen size={15} /> },
];

/**
 * Modal de escolha/troca de vídeo dentro da própria sala (sem sair nem desconectar).
 * Reaproveita o Catálogo e os formulários de fonte existentes da Home.
 */
export const MediaPickerModal: React.FC<MediaPickerModalProps> = ({
  open,
  onClose,
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

  const handleCommit = (
    payload: MediaPayload,
    mode: CommitMode,
    options?: CommitOptions
  ) => {
    onCommit(payload, mode, options);
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
    <Modal
      open={open}
      onClose={onClose}
      label={t('Escolher vídeo')}
      width={tab === 'catalog' ? 980 : 660}
      className="!p-5 !gap-4"
    >
      <ModalHeader
        title={t('Escolher vídeo')}
        description={t('Troque o vídeo ou explore o catálogo sem sair da sala.')}
        onClose={onClose}
      />

      <div className="overflow-x-auto no-scrollbar">
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

      <div className="min-h-[320px] flex justify-center">
        {tab === 'catalog' && (
          <div className="w-full">
            <Suspense
              fallback={
                <div role="status" aria-label={t('Carregando')} className="w-full min-h-[280px] flex items-center justify-center">
                  <Spinner size={28} className="text-lu-accent" />
                </div>
              }
            >
              <CatalogTab
                onWatch={(intent) => {
                  setWatchIntent(intent);
                  setTab('stream');
                }}
                onPlayStream={handlePlayStream}
                onCreateRoom={() => setTab('stream')}
              />
            </Suspense>
          </div>
        )}

        {tab === 'stream' && (
          <StreamStep
            recentStreams={recentStreams}
            onRemoveRecent={onRemoveRecent}
            onClearRecent={onClearRecent}
            intentTitle={watchIntent?.title}
            preferSolo={watchIntent?.preferSolo}
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

        {tab === 'youtube' && <YouTubeStep onBack={onClose} onCommit={handleCommit} />}

        {tab === 'drive' && <DriveStep onBack={onClose} onCommit={handleCommit} />}
      </div>
    </Modal>
  );
};
