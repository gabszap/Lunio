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
  inRoom?: boolean;
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
const MediaPickerContent: React.FC<Omit<MediaPickerModalProps, 'open'> & { onTabChange: (tab: PickerTab) => void }> = ({
  onClose,
  inRoom,
  initialTab = 'catalog',
  onTabChange,
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

  const selectTab = (next: PickerTab) => {
    setTab(next);
    onTabChange(next);
  };

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
      selectTab(step);
    }
  };

  return (
    <>
      <ModalHeader
        title={t('Escolher vídeo')}
        description={t('Troque o vídeo ou explore o catálogo sem sair da sala.')}
        onClose={onClose}
      />

      <div className="overflow-x-auto no-scrollbar">
        <PillTabs
          value={tab}
          onChange={(next) => {
            selectTab(next);
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
                syncUrl={false}
                onWatch={(intent) => {
                  setWatchIntent(intent);
                  selectTab('stream');
                }}
                onPlayStream={handlePlayStream}
                onCreateRoom={() => selectTab('stream')}
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
            inRoom={inRoom}
            pendingSubtitles={pendingSubtitles}
            onAddSubtitle={onAddSubtitle}
            onBack={() => (watchIntent ? selectTab('catalog') : onClose())}
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
      </div>
    </>
  );
};

export const MediaPickerModal: React.FC<MediaPickerModalProps> = (props) => {
  const { open, onClose, initialTab = 'catalog' } = props;
  const [activeTab, setActiveTab] = useState<PickerTab>(initialTab);

  return (
    <Modal
      open={open}
      onClose={() => {
        setActiveTab(initialTab);
        onClose();
      }}
      label={t('Escolher vídeo')}
      width={activeTab === 'catalog' ? 980 : 660}
      className="!p-5 !gap-4"
    >
      {open && (
        <MediaPickerContent
          {...props}
          onClose={() => {
            setActiveTab(initialTab);
            onClose();
          }}
          onTabChange={setActiveTab}
        />
      )}
    </Modal>
  );
};
