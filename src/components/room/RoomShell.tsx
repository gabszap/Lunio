import React, { useCallback, useEffect, useState } from 'react';
import { Compass, MonitorUp } from 'lucide-react';
import { prepareMediaLink } from '../../lib/roomMediaInput';
import { syncManager } from '../../lib/sync';
import { t } from '../../lib/i18n';
import type { RecentStream } from '../../lib/recent';
import type { StreamOption } from '../../lib/streams';
import type { CatalogRef } from '../../lib/continueWatching';
import type { CatalogSeriesContext } from '../../types/media';
import { PLAYLIST_MAX_ITEMS, REQUESTS_MAX_ITEMS, type PlaylistItem, type RoomState } from '../../types/sync';
import type { SourceCommit } from '../home/types';
import { PlayerConsole } from '../PlayerConsole';
import { useScreenShare } from '../player/ScreenShareContext';
import { GhostButton, Modal, ModalHeader, PrimaryButton } from '../ui';
import { RoomHeader } from './RoomHeader';
import { MemberStrip } from './MemberStrip';
import { RoomDock } from './RoomDock';
import { RoomSidebar, type RoomSidebarTab } from './RoomSidebar';
import { MediaPickerModal } from './MediaPickerModal';

export interface RoomShellProps {
  onHome: () => void;
  room: { connected: boolean; code: string; members: number; isHost: boolean };
  environment: 'discord' | 'web';
  hasSource: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onCloseSidebar: () => void;
  sidebarTab: RoomSidebarTab;
  onSidebarTabChange: (tab: RoomSidebarTab) => void;
  unreadChat: number;
  onOpenRoomLobby: () => void;
  onPlayQueueItem: (item: PlaylistItem) => void;
  /** Props do modal de escolha de mídia dentro da sala. */
  recentStreams: RecentStream[];
  onRemoveRecent: (url: string) => void;
  onClearRecent: () => void;
  pendingSubtitles: number;
  onAddSubtitle: () => void;
  ensureRoom: () => string;
  requireName: (then: () => void) => void;
  onCommitMedia: SourceCommit;
  onPlayCatalogStream: (
    stream: StreamOption,
    title: string,
    seriesContext?: CatalogSeriesContext,
    movie?: CatalogRef
  ) => void;
  /** Render prop do VideoPlayer recebendo roomState, onSelectMember, fullscreenDock, fullscreenSidebar e openMediaPicker. */
  renderPlayer: (ctx: {
    roomState: RoomState | null;
    onSelectMember: (memberId: string) => void;
    fullscreenDock: React.ReactNode;
    fullscreenSidebar: React.ReactNode;
    openMediaPicker: () => void;
  }) => React.ReactNode;
}

/**
 * Shell principal da sala (100dvh, sem scroll de página):
 * - Topo: RoomHeader (Logo + Sala/Duração + campo único de URL + botão da barra lateral)
 * - Esquerda: Palco automático (Telas 2/4 sem vídeo; Tela 3 16:9 + MemberStrip com vídeo/transmissão) + RoomDock
 * - Direita: RoomSidebar recolhível (Pedidos · Fila · Chat · Membros)
 * - Sob demanda: MediaPickerModal e Modal de Logs (PlayerConsole)
 */
export const RoomShell: React.FC<RoomShellProps> = ({
  onHome,
  room,
  environment,
  hasSource,
  sidebarOpen,
  onToggleSidebar,
  onCloseSidebar,
  sidebarTab,
  onSidebarTabChange,
  unreadChat,
  onOpenRoomLobby,
  onPlayQueueItem,
  recentStreams,
  onRemoveRecent,
  onClearRecent,
  pendingSubtitles,
  onAddSubtitle,
  ensureRoom,
  requireName,
  onCommitMedia,
  onPlayCatalogStream,
  renderPlayer,
}) => {
  const [roomState, setRoomState] = useState<RoomState | null>(() => syncManager.getRoomState());
  const [currentUser, setCurrentUser] = useState(() => syncManager.getUser());
  const [fallbackJoinedAt] = useState(() => Date.now());
  const [logsOpen, setLogsOpen] = useState(false);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [screenMenuOpen, setScreenMenuOpen] = useState(false);
  const [focusMemberId, setFocusMemberId] = useState<string | null>(null);
  const screenShare = useScreenShare();

  useEffect(() => {
    return syncManager.subscribeState((state) => {
      setRoomState(state ? { ...state } : null);
      setCurrentUser(syncManager.getUser());
    });
  }, []);

  const screenLive =
    screenShare.host.status === 'live' || screenShare.host.status === 'starting' || screenShare.covering;
  const showMediaStage = hasSource || screenLive;

  const handleLogoClick = useCallback(() => {
    if (room.connected) {
      if (!window.confirm(t('Sair desta sala e voltar para a tela inicial?'))) return;
    }
    onHome();
  }, [room.connected, onHome]);

  const handleSelectMember = useCallback(
    (memberId: string) => {
      setFocusMemberId(memberId);
      onSidebarTabChange('members');
      if (!sidebarOpen) onToggleSidebar();
    },
    [onSidebarTabChange, sidebarOpen, onToggleSidebar]
  );

  const handleSubmitUrl = useCallback(
    async (raw: string): Promise<string | null> => {
      const playlist = syncManager.getPlaylist();
      const requests = syncManager.getRequests();
      if (room.isHost) {
        const res = await prepareMediaLink(
          raw,
          playlist.map((p) => p.url),
          PLAYLIST_MAX_ITEMS
        );
        if ('error' in res) return res.error;
        syncManager.emitPlaylistAdd(res.item);
        if (sidebarOpen) onSidebarTabChange('queue');
        return null;
      }
      if (requests.length >= REQUESTS_MAX_ITEMS) return t('A lista de pedidos está cheia.');
      const res = await prepareMediaLink(
        raw,
        [...requests.map((r) => r.url), ...playlist.map((p) => p.url)],
        Number.POSITIVE_INFINITY
      );
      if ('error' in res) return res.error;
      syncManager.emitRequestAdd(res.item);
      if (sidebarOpen) onSidebarTabChange('requests');
      return null;
    },
    [room.isHost, sidebarOpen, onSidebarTabChange]
  );

  const createdAt = roomState?.createdAt ?? fallbackJoinedAt;
  const serverNow = useCallback(() => syncManager.getServerNow(), []);

  const openMediaPicker = useCallback(() => setMediaPickerOpen(true), []);

  const dockProps = {
    connected: room.connected,
    isHost: room.isHost,
    environment,
    roomCode: room.code,
    onOpenMediaPicker: openMediaPicker,
    onOpenRoomLobby,
    onLeaveRoom: onHome,
    onOpenLogs: () => setLogsOpen(true),
    screenOpen: screenMenuOpen,
    onScreenOpenChange: setScreenMenuOpen,
  };

  const sidebarProps = {
    open: sidebarOpen,
    activeTab: sidebarTab,
    onTabChange: onSidebarTabChange,
    onClose: onCloseSidebar,
    onOpenRoomLobby,
    onPlayQueueItem,
    onApproveRequest: (item: PlaylistItem, playNow?: boolean) => syncManager.emitRequestApprove(item.id, playNow),
    onRemoveRequest: (itemId: string) => syncManager.emitRequestRemove(itemId),
    unreadChat,
    focusMemberId,
  };

  return (
    <div className="h-dvh w-full bg-lu-bg text-lu-text flex flex-col p-3 gap-3 overflow-hidden box-border">
      <RoomHeader
        roomCode={room.code}
        roomName={roomState?.name}
        visibility={roomState?.visibility}
        locked={roomState?.locked}
        connected={room.connected}
        environment={environment}
        createdAt={createdAt}
        now={serverNow}
        isHost={room.isHost}
        sidebarOpen={sidebarOpen}
        unreadChat={unreadChat}
        onLogoClick={handleLogoClick}
        onToggleSidebar={onToggleSidebar}
        onSubmitUrl={handleSubmitUrl}
      />

      <div className="flex-1 min-h-0 flex gap-3">
        {/* Coluna esquerda: Palco (Telas 2/4 ou Tela 3 16:9) + MemberStrip (Tela 3) + RoomDock */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2.5">
          <div className="room-stage-container flex-1 min-h-0 relative z-0 flex items-center justify-center">
            {renderPlayer({
              roomState,
              onSelectMember: handleSelectMember,
              fullscreenDock: <RoomDock {...dockProps} isFullscreen />,
              fullscreenSidebar: <RoomSidebar {...sidebarProps} isFullscreen />,
              openMediaPicker,
            })}
          </div>

          {!showMediaStage && room.isHost && (
            <div className="flex-none rounded-[14px] bg-lu-bg2/90 border border-lu-border px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
              <span className="text-[13.5px] text-lu-muted">{t('Nenhum vídeo tocando ainda')}</span>
              <div className="flex items-center gap-2 flex-wrap">
                <PrimaryButton onClick={openMediaPicker} className="!h-9 !px-3.5 text-[13px]">
                  <Compass size={16} aria-hidden="true" />
                  <span>{t('Escolher vídeo')}</span>
                </PrimaryButton>
                {screenShare.canBroadcast && (
                  <GhostButton onClick={() => setScreenMenuOpen(true)} className="!h-9 !px-3.5 text-[13px]">
                    <MonitorUp size={16} aria-hidden="true" />
                    <span>{t('Compartilhar tela')}</span>
                  </GhostButton>
                )}
              </div>
            </div>
          )}

          {showMediaStage && room.connected && (
            <MemberStrip
              members={roomState?.members ?? []}
              currentUserId={currentUser.id}
              roomState={roomState}
              onSelectMember={handleSelectMember}
            />
          )}

          <RoomDock {...dockProps} />
        </div>

        {/* Coluna direita: Barra lateral acoplada (Pedidos · Fila · Chat · Membros) */}
        <RoomSidebar {...sidebarProps} />
      </div>

      <MediaPickerModal
        open={mediaPickerOpen}
        onClose={() => setMediaPickerOpen(false)}
        inRoom={room.connected}
        isHost={room.isHost}
        roomCode={room.code}
        recentStreams={recentStreams}
        onRemoveRecent={onRemoveRecent}
        onClearRecent={onClearRecent}
        pendingSubtitles={pendingSubtitles}
        onAddSubtitle={onAddSubtitle}
        ensureRoom={ensureRoom}
        requireName={requireName}
        onCommit={onCommitMedia}
        onSuggestMedia={(item) => {
          const requests = syncManager.getRequests();
          const playlist = syncManager.getPlaylist();
          if (requests.length >= REQUESTS_MAX_ITEMS) return;
          void prepareMediaLink(
            item.url,
            [...requests.map((r) => r.url), ...playlist.map((p) => p.url)],
            Number.POSITIVE_INFINITY
          ).then((res) => {
            if ('error' in res) return;
            syncManager.emitRequestAdd({
              ...res.item,
              title: item.title || res.item.title,
              mimeType: item.mimeType || res.item.mimeType,
            });
            onSidebarTabChange('requests');
            if (!sidebarOpen) onToggleSidebar();
          });
        }}
        onPlayStream={onPlayCatalogStream}
      />

      <Modal open={logsOpen} onClose={() => setLogsOpen(false)} label={t('Console do player')} width={760} className="!p-5 !gap-4">
        <ModalHeader title={t('Console do player')} onClose={() => setLogsOpen(false)} />
        <PlayerConsole />
      </Modal>
    </div>
  );
};
