import React, { useEffect, useState } from 'react';
import { History, X } from 'lucide-react';
import { HomeCard, IconButton, PrimaryButton } from '../ui';
import { t } from '../../lib/i18n';
import { discordManager } from '../../lib/discord';
import { agoLabel, clearLastRoom, loadLastRoom, type LastRoom } from '../../lib/lastRoom';
import { checkRoom } from './RoomSteps';

/** "Voltar à sala": aparece na Home se a última sala da pessoa ainda existe no servidor (sala encerrada ou sem registro some sozinha). */
export const LastRoomCard: React.FC<{ onRejoin: (code: string) => void }> = ({ onRejoin }) => {
  const [found, setFound] = useState<{ room: LastRoom; members: number } | null>(null);

  useEffect(() => {
    if (discordManager.isDiscordActivity()) return;
    const room = loadLastRoom();
    if (!room) return;
    let cancelled = false;
    void checkRoom(room.code).then((info) => {
      if (cancelled || !info) return; // servidor fora do ar: não mostra, mas guarda para a próxima vez
      if (info.exists) setFound({ room, members: info.members });
      else clearLastRoom();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!found) return null;
  const { room, members } = found;
  return (
    <HomeCard className="!p-4 sm:!p-4">
      <div className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-[10px] bg-lu-elevated text-lu-accent flex items-center justify-center flex-none">
          <History size={20} />
        </span>
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="text-[14px] font-semibold text-lu-text truncate">
            {t('Voltar à sala')} <span className="tracking-[0.08em]">{room.code}</span>
          </span>
          <span className="text-[12px] text-lu-muted">
            {t('Você saiu {ago}', { ago: agoLabel(Date.now() - room.at) })} · {members === 0 ? t('ninguém na sala agora') : members === 1 ? t('1 pessoa na sala') : t('{n} pessoas na sala', { n: members })}
          </span>
        </div>
        <PrimaryButton onClick={() => onRejoin(room.code)}>{t('Voltar')}</PrimaryButton>
        <IconButton
          label={t('Esquecer essa sala')}
          size={40}
          tone="muted"
          onClick={() => {
            clearLastRoom();
            setFound(null);
          }}
        >
          <X size={16} />
        </IconButton>
      </div>
    </HomeCard>
  );
};
