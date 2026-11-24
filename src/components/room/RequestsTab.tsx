import React from 'react';
import { Check, Inbox, Play, X } from 'lucide-react';
import { t } from '../../lib/i18n';
import type { PlaylistItem } from '../../types/sync';
import { IconButton } from '../ui';

export interface RequestsTabProps {
  requests: PlaylistItem[];
  isHost: boolean;
  currentUserId: string;
  onApprove?: (item: PlaylistItem, playNow?: boolean) => void;
  onRemove?: (itemId: string) => void;
}

export const RequestsTab: React.FC<RequestsTabProps> = ({ requests, isHost, currentUserId, onApprove, onRemove }) => {
  return (
    <section aria-label={t('Pedidos da sala')} className="flex-1 min-h-0 flex flex-col">
      {requests.length === 0 ? (
        <div className="flex-1 px-5 py-6 flex flex-col items-center justify-center text-center gap-2 text-lu-muted">
          <Inbox size={26} className="opacity-60" />
          <p className="m-0 text-[14px]">{t('Nenhum pedido pendente.')}</p>
          <p className="m-0 text-[12px] text-lu-disabled max-w-[260px]">
            {t('Espectadores podem colar links no campo superior para sugerir vídeos ao Host.')}
          </p>
        </div>
      ) : (
        <ul className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 flex flex-col gap-2 list-none m-0">
          {requests.map((item) => {
            const isAuthor = item.addedById === currentUserId;
            return (
              <li
                key={item.id}
                className="flex items-center gap-2.5 p-2.5 pl-3 rounded-[12px] bg-lu-surface border border-lu-border"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold truncate" title={item.title}>
                    {item.title}
                  </div>
                  <div className="text-[12px] text-lu-muted truncate">{t('Pedido por {name}', { name: item.addedBy })}</div>
                </div>

                {isHost ? (
                  <div className="flex items-center flex-none">
                    <IconButton
                      label={t('Aprovar para a fila')}
                      size={36}
                      tone="muted"
                      className="hover:text-lu-success hover:bg-lu-success/12"
                      onClick={() => onApprove?.(item, false)}
                    >
                      <Check size={15} />
                    </IconButton>
                    <IconButton label={t('Tocar agora')} size={36} onClick={() => onApprove?.(item, true)}>
                      <Play size={15} />
                    </IconButton>
                    <IconButton
                      label={t('Recusar pedido')}
                      size={36}
                      tone="muted"
                      className="hover:text-lu-error hover:bg-lu-error/12"
                      onClick={() => onRemove?.(item.id)}
                    >
                      <X size={15} />
                    </IconButton>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 flex-none">
                    <span className="px-2 py-0.5 rounded-md bg-lu-elevated border border-lu-border text-[11px] font-medium text-lu-muted whitespace-nowrap">
                      {t('Aguardando Host')}
                    </span>
                    {isAuthor && (
                      <IconButton label={t('Cancelar pedido')} size={36} tone="muted" onClick={() => onRemove?.(item.id)}>
                        <X size={15} />
                      </IconButton>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
