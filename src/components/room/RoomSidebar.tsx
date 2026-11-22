import React, { useEffect, useRef, useState } from 'react';
import { Users, X } from 'lucide-react';
import { t } from '../../lib/i18n';
import { syncManager } from '../../lib/sync';
import type { ChatMessage, PlaylistItem, RoomState } from '../../types/sync';
import { IconButton, PrimaryButton, cx, useSlidingPill } from '../ui';
import { ChatTab } from './ChatTab';
import { MembersTab } from './MembersTab';
import { QueueTab } from './QueueTab';
import { RequestsTab } from './RequestsTab';

export type RoomSidebarTab = 'requests' | 'queue' | 'chat' | 'members';

const SIDEBAR_TAB_ORDER: Record<RoomSidebarTab, number> = {
  requests: 0,
  queue: 1,
  chat: 2,
  members: 3,
};

export interface RoomSidebarProps {
  open: boolean;
  activeTab: RoomSidebarTab;
  onTabChange: (tab: RoomSidebarTab) => void;
  onClose: () => void;
  onOpenRoomLobby: () => void;
  onPlayQueueItem: (item: PlaylistItem) => void;
  onApproveRequest?: (item: PlaylistItem, playNow?: boolean) => void;
  onRemoveRequest?: (itemId: string) => void;
  unreadChat: number;
  isFullscreen?: boolean;
  focusMemberId?: string | null;
}

export const RoomSidebar: React.FC<RoomSidebarProps> = ({
  open,
  activeTab,
  onTabChange,
  onClose,
  onOpenRoomLobby,
  onPlayQueueItem,
  onApproveRequest,
  onRemoveRequest,
  unreadChat,
  isFullscreen = false,
  focusMemberId,
}) => {
  const [roomState, setRoomState] = useState<RoomState | null>(() => syncManager.getRoomState());
  const [currentUser, setCurrentUser] = useState(() => syncManager.getUser());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => [...syncManager.getChatHistory()]);

  useEffect(() => {
    const unsubState = syncManager.subscribeState((state) => {
      setRoomState(state ? { ...state } : null);
      setCurrentUser(syncManager.getUser());
    });

    const unsubChat = syncManager.subscribeChat(() => {
      setChatMessages([...syncManager.getChatHistory()]);
    });

    return () => {
      unsubState();
      unsubChat();
    };
  }, []);

  // Ao abrir o painel na aba chat, garante sincronismo com histórico mais recente.
  useEffect(() => {
    if (open && activeTab === 'chat') {
      setChatMessages([...syncManager.getChatHistory()]);
    }
  }, [open, activeTab]);

  const status = syncManager.getStatus();
  const isHost = syncManager.isRoomHost();
  const members = roomState?.members || [];
  const queueCount = roomState?.playlist?.length ?? syncManager.getPlaylist().length;
  const requests = (roomState as (RoomState & { requests?: PlaylistItem[] }) | null)?.requests ?? [];

  const prevTabRef = useRef<RoomSidebarTab>(activeTab);
  const directionRef = useRef<'right' | 'left' | null>(null);
  if (prevTabRef.current !== activeTab) {
    directionRef.current = SIDEBAR_TAB_ORDER[activeTab] >= SIDEBAR_TAB_ORDER[prevTabRef.current] ? 'right' : 'left';
    prevTabRef.current = activeTab;
  }
  const panelAnimClass =
    directionRef.current === 'right'
      ? 'lu-tab-panel-right'
      : directionRef.current === 'left'
      ? 'lu-tab-panel-left'
      : undefined;

  const pillLayoutKey = `${open ? 1 : 0}:${status.isConnected ? 1 : 0}:${requests.length}:${queueCount}:${unreadChat}:${members.length}`;
  const { listRef, clipPath, animated, setButtonRef } = useSlidingPill(activeTab, 8, pillLayoutKey);

  const tabs: Array<{ id: RoomSidebarTab; label: string; count?: number; accentBadge?: boolean }> = [
    { id: 'requests', label: t('Pedidos'), count: requests.length > 0 ? requests.length : undefined, accentBadge: true },
    { id: 'queue', label: t('Fila'), count: queueCount > 0 ? queueCount : undefined },
    { id: 'chat', label: t('Chat'), count: unreadChat > 0 && activeTab !== 'chat' ? unreadChat : undefined, accentBadge: true },
    { id: 'members', label: t('Membros'), count: members.length },
  ];

  return (
    <aside
      role="complementary"
      aria-label={t('Watch Party')}
      aria-hidden={!open}
      inert={!open ? ('' as unknown as boolean) : undefined}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cx(
        'rounded-2xl bg-lu-bg2 border border-lu-border flex flex-col min-h-0 overflow-hidden text-lu-text cursor-auto',
        isFullscreen
          ? cx(
              'fixed inset-y-3 right-3 z-50 w-[min(360px,calc(100vw-24px))] shadow-[0_24px_64px_rgba(0,0,0,0.6)] transition-[transform,opacity] duration-200 ease-out',
              open ? 'translate-x-0 opacity-100 pointer-events-auto' : 'translate-x-[calc(100%+24px)] opacity-0 pointer-events-none'
            )
          : cx(
              'flex-none transition-[width,opacity,margin,transform] duration-200 ease-out',
              'max-lg:fixed max-lg:inset-y-3 max-lg:right-3 max-lg:z-50 max-lg:w-[min(360px,calc(100vw-24px))] max-lg:shadow-[0_24px_64px_rgba(0,0,0,0.6)]',
              open
                ? 'lg:w-[360px] opacity-100 max-lg:translate-x-0 pointer-events-auto'
                : 'lg:w-0 lg:-ml-3 lg:border-transparent opacity-0 max-lg:translate-x-[calc(100%+24px)] pointer-events-none'
            )
      )}
    >
      {/* Cabeçalho compacto com botão de fechar quando em tela cheia ou drawer (< lg) */}
      <div
        className={cx(
          'items-center justify-between px-3.5 py-2 border-b border-lu-border flex-none',
          isFullscreen ? 'flex' : 'flex lg:hidden'
        )}
      >
        <span className="text-[13px] font-semibold text-lu-text">{t('Watch Party')}</span>
        <IconButton label={t('Fechar painel')} size={36} tone="muted" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>

      {!status.isConnected ? (
        <div className="flex-1 p-6 flex flex-col items-center justify-center text-center gap-4">
          <span className="w-12 h-12 rounded-[14px] bg-lu-tint border border-lu-accent/30 text-lu-accent flex items-center justify-center">
            <Users size={22} />
          </span>
          <div>
            <h3 className="m-0 text-[15px] font-semibold">{t('Você está assistindo sozinho')}</h3>
            <p className="mt-1.5 mb-0 max-w-[260px] text-[13px] text-lu-muted">
              {t('Crie uma sala pros amigos ou entre em uma com o código que te mandaram.')}
            </p>
          </div>
          <PrimaryButton onClick={onOpenRoomLobby}>
            <Users size={17} />
            {t('Criar ou entrar em sala')}
          </PrimaryButton>
        </div>
      ) : (
        <>
          <div className="p-2 border-b border-lu-border flex-none">
            <div ref={listRef} role="tablist" aria-label={t('Watch Party')} className="relative flex items-center gap-1 p-1 rounded-[12px] bg-lu-bg">
              {clipPath && (
                <span
                  aria-hidden="true"
                  className={cx('lu-pill-indicator', animated && 'lu-pill-indicator-animated')}
                  style={{ clipPath }}
                />
              )}
              {tabs.map((tab) => {
                const selected = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    ref={setButtonRef(tab.id)}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => onTabChange(tab.id)}
                    className={cx(
                      'lu-pill-btn relative z-10 appearance-none flex-auto inline-flex items-center justify-center gap-1.5 h-8 px-2 rounded-[8px] text-[12px] font-[inherit] whitespace-nowrap',
                      selected
                        ? cx('text-lu-accent font-semibold', !clipPath && 'bg-lu-tint')
                        : 'bg-transparent text-lu-muted font-medium'
                    )}
                  >
                    <span>{tab.label}</span>
                    {tab.count !== undefined && (
                      <span
                        className={cx(
                          'flex-none text-[10.5px] leading-none tabular',
                          tab.accentBadge
                            ? 'min-w-[16px] h-4 px-1 rounded-full bg-lu-accent text-lu-bg font-bold inline-flex items-center justify-center'
                            : 'text-lu-muted font-medium'
                        )}
                      >
                        {tab.count > 99 ? '99+' : tab.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {activeTab === 'requests' && (
            <div key="requests" className={cx('flex-1 min-h-0 flex flex-col', panelAnimClass)}>
              <RequestsTab
                requests={requests}
                isHost={isHost}
                currentUserId={currentUser.id}
                onApprove={onApproveRequest}
                onRemove={onRemoveRequest}
              />
            </div>
          )}

          {activeTab === 'queue' && (
            <div key="queue" className={cx('flex-1 min-h-0 flex flex-col', panelAnimClass)}>
              <QueueTab onPlayItem={onPlayQueueItem} />
            </div>
          )}

          {/* Mantém ChatTab montado quando oculto para preservar o rascunho digitado ao trocar de aba */}
          <div className={activeTab === 'chat' ? cx('flex-1 min-h-0 flex flex-col', panelAnimClass) : 'hidden'}>
            <ChatTab
              messages={chatMessages}
              members={members}
              currentUserId={currentUser.id}
              active={open && activeTab === 'chat'}
            />
          </div>

          {activeTab === 'members' && (
            <div key="members" className={cx('flex-1 min-h-0 flex flex-col', panelAnimClass)}>
              <MembersTab
                members={members}
                roomState={roomState}
                currentUser={currentUser}
                isHost={isHost}
                focusMemberId={focusMemberId}
              />
            </div>
          )}
        </>
      )}
    </aside>
  );
};
