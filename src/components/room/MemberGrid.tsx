import React from 'react';
import { Crown } from 'lucide-react';
import type { RoomMember, RoomState } from '../../types/sync';
import { t } from '../../lib/i18n';
import { Dot, cx } from '../ui';
import { RoomAvatar, memberCardTint, memberSyncMeta, sortRoomMembers } from './memberUtils';

interface MemberGridProps {
  members: RoomMember[];
  currentUserId: string;
  currentUsername: string;
  roomState: RoomState | null;
  onSelectMember?: (memberId: string) => void;
}

/**
 * Palco sem vídeo/transmissão:
 * - 1 membro: card grande único centralizado (avatar grande + nome HOST no canto inferior esquerdo).
 * - 2+ membros: grid responsivo de cards lado a lado estilo Discord em tela cheia.
 */
export const MemberGrid: React.FC<MemberGridProps> = ({
  members,
  currentUserId,
  currentUsername,
  roomState,
  onSelectMember,
}) => {
  const ordered = sortRoomMembers(members, currentUserId);
  const displayList: RoomMember[] =
    ordered.length > 0
      ? ordered
      : [
          {
            id: currentUserId || 'self',
            username: currentUsername || t('Você'),
            isHost: true,
            ready: true,
            state: 'ready',
            currentTime: 0,
            ping: 0,
          },
        ];

  const single = displayList.length === 1;
  const colsClass =
    displayList.length === 1
      ? 'grid-cols-1'
      : displayList.length <= 4
        ? 'grid-cols-1 sm:grid-cols-2'
        : 'grid-cols-2 md:grid-cols-3';

  return (
    <div
      id="room-member-grid"
      className={cx(
        'w-full h-full min-h-0 rounded-[18px] border border-lu-border bg-lu-video p-4 sm:p-5 overflow-y-auto custom-scrollbar flex items-center justify-center'
      )}
    >
      <div
        className={cx(
          'w-full grid gap-4',
          colsClass,
          single ? 'h-full' : 'max-w-[960px] auto-rows-[minmax(200px,1fr)]'
        )}
      >
        {displayList.map((member) => {
          const syncMeta = memberSyncMeta(member, roomState);
          const isMe = member.id === currentUserId;
          return (
            <button
              key={member.id}
              type="button"
              onClick={() => onSelectMember?.(member.id)}
              className={cx(
                'relative w-full rounded-[16px] border border-lu-border hover:border-lu-border-strong transition-colors flex flex-col items-center justify-center p-6 select-none overflow-hidden text-left',
                single ? 'h-full min-h-[260px]' : 'aspect-[4/3] min-h-[190px] max-h-[320px]',
                memberCardTint(member.id, member.isHost)
              )}
            >
              <span
                title={syncMeta.label}
                className="absolute top-3.5 right-3.5 inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-lu-bg/65 border border-lu-border text-[11px] text-lu-muted"
              >
                <Dot tone={syncMeta.tone} />
              </span>

              <RoomAvatar name={member.username} url={member.avatarUrl} size={single ? 'lg' : 'md'} />

              <div className="absolute left-3.5 bottom-3.5 right-3.5 flex items-center gap-2 min-w-0">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-lu-bg/75 backdrop-blur-sm border border-lu-border text-[13px] font-semibold text-lu-text truncate">
                  <span className="truncate">{member.username}</span>
                  {member.isHost && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold tracking-[0.04em] text-lu-accent uppercase flex-none">
                      <Crown size={11} />
                      {t('Host')}
                    </span>
                  )}
                  {isMe && !member.isHost && (
                    <span className="text-[11px] font-normal text-lu-muted flex-none">({t('você')})</span>
                  )}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
