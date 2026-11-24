import React from 'react';
import { Crown } from 'lucide-react';
import type { RoomMember, RoomState } from '../../types/sync';
import { t } from '../../lib/i18n';
import { Dot, cx } from '../ui';
import { RoomAvatar, memberCardTint, memberSyncMeta, sortRoomMembers } from './memberUtils';

interface MemberStripProps {
  members: RoomMember[];
  currentUserId: string;
  roomState: RoomState | null;
  onSelectMember?: (memberId: string) => void;
}

/**
 * Faixa horizontal compacta de participantes exibida logo abaixo da área de vídeo 16:9
 * quando há vídeo ou transmissão de tela ativa.
 */
export const MemberStrip: React.FC<MemberStripProps> = ({
  members,
  currentUserId,
  roomState,
  onSelectMember,
}) => {
  const ordered = sortRoomMembers(members, currentUserId);
  if (ordered.length === 0) return null;

  return (
    <div
      id="room-member-strip"
      aria-label={t('Participantes')}
      className="flex-none h-[96px] flex items-stretch gap-2.5 overflow-x-auto no-scrollbar py-0.5"
    >
      {ordered.map((member) => {
        const syncMeta = memberSyncMeta(member, roomState);
        return (
          <button
            key={member.id}
            type="button"
            title={`${member.username} · ${syncMeta.label}`}
            onClick={() => onSelectMember?.(member.id)}
            className={cx(
              'relative w-[156px] flex-none rounded-[12px] border border-lu-border hover:border-lu-border-strong transition-colors flex flex-col items-center justify-center select-none overflow-hidden',
              memberCardTint(member.id, member.isHost)
            )}
          >
            <span className="absolute top-1.5 right-1.5 inline-flex items-center gap-1">
              {syncMeta.buffering ? (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-lu-warning/15 border border-lu-warning/35 text-[9.5px] font-semibold text-lu-warning animate-pulse">
                  <Dot tone="warning" />
                  {t('Carregando…')}
                </span>
              ) : syncMeta.behindBadge ? (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-lu-warning/15 border border-lu-warning/35 text-[9.5px] font-semibold text-lu-warning tabular">
                  <Dot tone="warning" />
                  {syncMeta.behindBadge}
                </span>
              ) : (
                <Dot tone={syncMeta.tone} />
              )}
            </span>

            <div className="mb-6">
              <RoomAvatar name={member.username} url={member.avatarUrl} size="sm" />
            </div>

            <div className="absolute left-2 bottom-2 right-2 flex items-center min-w-0">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-lu-bg/80 text-[11px] font-semibold text-lu-text truncate max-w-full">
                <span className="truncate">{member.username}</span>
                {member.isHost && (
                  <span className="inline-flex items-center gap-0.5 text-[9px] font-bold tracking-[0.04em] text-lu-accent uppercase flex-none">
                    <Crown size={9} />
                    {t('Host')}
                  </span>
                )}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
};
