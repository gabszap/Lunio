import React from 'react';
import { formatTime } from '../../lib/chapters';
import { t } from '../../lib/i18n';
import type { RoomMember, RoomState } from '../../types/sync';
import { cx } from '../ui';

/** Ordena membros: Host no topo, depois você, depois ordem alfabética. */
export function sortRoomMembers(rawMembers: RoomMember[], currentUserId: string): RoomMember[] {
  const unique = Array.from(new Map(rawMembers.map((m) => [m.id, m])).values());
  return unique.sort((a, b) => {
    if (a.isHost && !b.isHost) return -1;
    if (!a.isHost && b.isHost) return 1;
    if (a.id === currentUserId && b.id !== currentUserId) return -1;
    if (a.id !== currentUserId && b.id === currentUserId) return 1;
    return a.username.localeCompare(b.username);
  });
}

/** O Host que está com a transmissão de tela ao vivo. */
export function memberTransmitting(member: { id: string }, room: RoomState | null): boolean {
  return Boolean(room?.screen?.live && room.screen.hostId === member.id);
}

/** "Atrasado 1:23" / "Adiantado 0:05" quando o servidor mede 2 s ou mais de diferença para o Host. */
export function behindLabel(member: { isHost: boolean; behindMs?: number }, room: RoomState | null): { text: string } | null {
  const ms = member.behindMs;
  if (member.isHost || ms === undefined || !room?.playback.playing || Math.abs(ms) < 2000) return null;
  const time = formatTime(Math.abs(ms) / 1000);
  return { text: ms > 0 ? t('Atrasado {time}', { time }) : t('Adiantado {time}', { time }) };
}

/** Status resumido de sincronia de um membro para o dot/tooltip dos cards. */
export function memberSyncMeta(member: RoomMember, room: RoomState | null): { tone: 'success' | 'warning'; label: string } {
  const transmitting = memberTransmitting(member, room);
  const behind = behindLabel(member, room);
  if (transmitting) return { tone: 'success', label: t('Transmitindo') };
  if (member.watchingScreen) return { tone: 'success', label: t('Assistindo') };
  if (behind) return { tone: 'warning', label: behind.text };
  if (member.ready) return { tone: 'success', label: t('Sincronizado') };
  return { tone: 'warning', label: t('Aguardando') };
}

/** Paleta sutil de fundo de card por usuário (determinística pelo id, fiel aos tons escuros do Lunio). */
const CARD_TINTS = [
  'bg-[radial-gradient(circle_at_50%_42%,rgba(124,58,237,0.22),#10131a_78%)]',
  'bg-[radial-gradient(circle_at_50%_42%,rgba(56,189,248,0.16),#10131a_78%)]',
  'bg-[radial-gradient(circle_at_50%_42%,rgba(74,222,128,0.14),#10131a_78%)]',
  'bg-[radial-gradient(circle_at_50%_42%,rgba(167,139,250,0.18),#10131a_78%)]',
];

export function memberCardTint(id: string, isHost: boolean): string {
  if (isHost) return CARD_TINTS[0];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return CARD_TINTS[(Math.abs(hash) % (CARD_TINTS.length - 1)) + 1];
}

/** Avatar escalável para cards de palco (40 px na faixa, 76 px nos cards grandes). */
export const RoomAvatar: React.FC<{ name: string; url?: string; size?: 'sm' | 'md' | 'lg' }> = ({ name, url, size = 'md' }) => {
  const dim = size === 'lg' ? 'w-20 h-20 text-[26px]' : size === 'md' ? 'w-14 h-14 text-[18px]' : 'w-10 h-10 text-[14px]';
  if (url) {
    return <img src={url} alt="" className={cx('flex-none rounded-full object-cover border border-white/12 shadow-[0_8px_24px_rgba(0,0,0,0.4)]', dim)} />;
  }
  const initials = name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
  return (
    <div
      aria-hidden="true"
      className={cx(
        'flex-none rounded-full bg-lu-elevated border border-white/12 flex items-center justify-center font-semibold text-lu-text shadow-[0_8px_24px_rgba(0,0,0,0.4)]',
        dim
      )}
    >
      {initials}
    </div>
  );
};
