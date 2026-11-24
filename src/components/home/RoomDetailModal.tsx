import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Film, Globe, Link, MonitorUp, Play, Radio, Tv, X } from 'lucide-react';
import { Dot, GhostButton, IconButton, Modal, PrimaryButton, cx } from '../ui';
import { t } from '../../lib/i18n';
import { formatRoomUrl } from '../../lib/roomCode';
import { copyText } from '../../lib/recent';
import type { PublicRoomActivity, PublicRoomMember, PublicRoomSummary } from '../../types/sync';

function formatCreatedAt(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatCompactAgo(createdAt: number, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - createdAt) / 60_000));
  if (min < 1) return t('agora há pouco');
  if (min < 60) return t('há {n} min', { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('há {n} h', { n: hours });
  return t('há {n} d', { n: Math.floor(hours / 24) });
}

function initialsFrom(name: string): string {
  return name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
}

export const RoomBannerVisual: React.FC<{
  previewUrl: string | null;
  activity: PublicRoomActivity;
  imageClassName?: string;
}> = ({ previewUrl, activity, imageClassName }) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(previewUrl && failedUrl !== previewUrl);

  if (showImage && previewUrl) {
    return (
      <>
        <img
          src={previewUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedUrl(previewUrl)}
          className={cx('w-full h-full object-cover block', imageClassName)}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-lu-bg/45 via-transparent to-lu-bg/15"
        />
      </>
    );
  }

  const PlaceholderIcon = activity === 'screen' ? MonitorUp : activity === 'media' ? Film : Tv;

  return (
    <div className="w-full h-full lu-video-bg flex items-center justify-center relative">
      <div
        aria-hidden="true"
        className={cx(
          'w-12 h-12 rounded-2xl border flex items-center justify-center',
          activity === 'screen'
            ? 'bg-lu-error/12 border-lu-error/25 text-lu-error'
            : activity === 'media'
            ? 'bg-lu-tint border-lu-accent/25 text-lu-accent'
            : 'bg-lu-surface/80 border-lu-border text-lu-muted'
        )}
      >
        <PlaceholderIcon size={22} strokeWidth={1.65} />
      </div>
    </div>
  );
};

export const CompactAvatar: React.FC<{ member: PublicRoomMember; size: 24 | 28 }> = ({ member, size }) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImg = Boolean(member.avatarUrl && failedUrl !== member.avatarUrl);
  const sizeClass = size === 28 ? 'w-7 h-7 text-[11px]' : 'w-6 h-6 text-[10px]';

  if (showImg && member.avatarUrl) {
    return (
      <img
        src={member.avatarUrl}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailedUrl(member.avatarUrl ?? null)}
        className={cx(sizeClass, 'rounded-full object-cover flex-none ring-2 ring-lu-surface bg-lu-elevated')}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cx(
        sizeClass,
        'rounded-full flex-none ring-2 ring-lu-surface bg-lu-elevated border border-lu-border flex items-center justify-center font-semibold text-lu-text'
      )}
    >
      {initialsFrom(member.username)}
    </span>
  );
};

export const RoomDetailModal: React.FC<{
  room: PublicRoomSummary | null;
  onClose: () => void;
  onJoin: (code: string) => void;
}> = ({ room, onClose, onJoin }) => {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setCopied(false);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, [room?.code]);

  const handleCopy = async () => {
    if (!room) return;
    const ok = await copyText(formatRoomUrl(room.code));
    if (!ok) return;
    setCopied(true);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = null;
    }, 1800);
  };

  const extraCount = room ? Math.max(0, room.membersCount - room.members.length) : 0;
  const memberNames = room
    ? `${room.members.map((m) => m.username).join(', ')}${extraCount > 0 ? ` +${extraCount}` : ''}`
    : '';

  return (
    <Modal
      open={room !== null}
      onClose={onClose}
      label={room?.name || t('Detalhes da sala')}
      width={480}
      className="!p-0 !gap-0 !overflow-hidden"
    >
      {room && (
        <div className="flex flex-col min-h-0 flex-1 overflow-y-auto custom-scrollbar">
          <div className="relative h-[190px] w-full flex-none overflow-hidden bg-lu-bg2 border-b border-lu-border">
            <RoomBannerVisual previewUrl={room.previewUrl} activity={room.activity} />
            <IconButton
              label={t('Fechar')}
              size={36}
              onClick={onClose}
              className="!absolute top-3 right-3 !bg-lu-bg/75 hover:!bg-lu-bg/90 backdrop-blur-sm border border-lu-border"
            >
              <X size={17} strokeWidth={1.85} />
            </IconButton>
          </div>

          <div className="p-6 flex flex-col gap-5">
            <div className="min-w-0">
              <h2 className="m-0 text-[22px] font-bold tracking-[-0.02em] leading-tight text-lu-text break-words">
                {room.name}
              </h2>
              <p className="mt-1 mb-0 text-[12.5px] font-mono text-lu-muted">/room/{room.code}</p>
            </div>

            <div className="flex flex-col border-b border-lu-border">
              <div className="border-t border-lu-border py-3 flex items-center justify-between gap-4 text-[13.5px]">
                <span className="text-lu-muted flex-none">{t('Pessoas')}</span>
                <span className="font-medium text-lu-text tabular">
                  {room.membersCount === 1 ? t('1 pessoa') : t('{n} pessoas', { n: room.membersCount })}
                </span>
              </div>

              <div className="border-t border-lu-border py-3 flex items-center justify-between gap-4 text-[13.5px]">
                <span className="text-lu-muted flex-none">{t('Criada')}</span>
                <span className="text-right tabular">
                  <span className="font-medium text-lu-text">{formatCreatedAt(room.createdAt)}</span>{' '}
                  <span className="text-lu-muted">({formatCompactAgo(room.createdAt)})</span>
                </span>
              </div>

              <div className="border-t border-lu-border py-3 flex items-center justify-between gap-4 text-[13.5px]">
                <span className="text-lu-muted flex-none">{t('Acesso')}</span>
                <span className="inline-flex items-center gap-1.5 font-medium text-lu-text">
                  <Globe size={14} className="text-lu-accent flex-none" aria-hidden="true" />
                  <span>{t('Pública')}</span>
                </span>
              </div>

              <div className="border-t border-lu-border py-3 flex items-center justify-between gap-4 text-[13.5px]">
                <span className="text-lu-muted flex-none">{t('Host')}</span>
                <span className="font-medium text-lu-text truncate min-w-0">{room.hostName}</span>
              </div>

              <div className="border-t border-lu-border py-3 flex items-center justify-between gap-4 text-[13.5px]">
                <span className="text-lu-muted flex-none">{t('Status')}</span>
                {room.activity === 'screen' ? (
                  <span className="inline-flex items-center gap-1.5 font-semibold text-lu-error">
                    <Radio size={14} className="flex-none" aria-hidden="true" />
                    <span>{t('Ao vivo')}</span>
                  </span>
                ) : room.activity === 'media' ? (
                  <span className="inline-flex items-center gap-1.5 min-w-0 text-lu-text">
                    <Play size={13} className="text-lu-accent flex-none" aria-hidden="true" />
                    <span className="font-medium flex-none">{t('Assistindo')}</span>
                    {room.mediaTitle && (
                      <span className="text-lu-muted truncate min-w-0" title={room.mediaTitle}>
                        · {room.mediaTitle}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-lu-muted">
                    <Dot tone="muted" />
                    <span>{t('Aguardando mídia')}</span>
                  </span>
                )}
              </div>
            </div>

            {room.members.length > 0 && (
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex items-center -space-x-2 flex-none">
                  {room.members.slice(0, 5).map((member, idx) => (
                    <CompactAvatar key={`${member.username}-${idx}`} member={member} size={28} />
                  ))}
                </div>
                <span className="text-[13px] text-lu-muted truncate flex-1 min-w-0" title={memberNames}>
                  {memberNames}
                </span>
              </div>
            )}

            <div className="pt-2 flex items-center justify-end gap-2.5">
              <GhostButton
                size="lg"
                onClick={() => void handleCopy()}
                aria-label={t('Copiar link da sala')}
                title={copied ? t('Link copiado') : t('Copiar link da sala')}
                className={cx('!w-12 !px-0', copied && '!border-lu-success/50 !text-lu-success')}
              >
                {copied ? <Check size={17} aria-hidden="true" /> : <Link size={17} aria-hidden="true" />}
              </GhostButton>
              <PrimaryButton size="lg" onClick={() => onJoin(room.code)}>
                <span>{t('Entrar na sala')}</span>
                <ArrowRight size={17} aria-hidden="true" />
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};
