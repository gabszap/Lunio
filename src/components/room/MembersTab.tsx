import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Ban, Check, Crown, Eye, Globe, Lock, PenLine, Settings2, Shield, UserMinus, UserX } from 'lucide-react';
import { t } from '../../lib/i18n';
import { roomCodeFrom } from '../../lib/roomCode';
import { syncManager } from '../../lib/sync';
import type { RoomMember, RoomState, RoomVisibility } from '../../types/sync';
import { setSkipNamePrompt, shouldSkipNamePrompt } from '../UsernameModal';
import { Avatar, Dot, IconButton, PrimaryButton, Segmented, TextButton, TextInput, cx } from '../ui';
import { behindLabel, memberTransmitting, sortRoomMembers } from './memberUtils';

export interface MembersTabProps {
  members: RoomMember[];
  roomState: RoomState | null;
  currentUser: { id: string; username: string };
  isHost: boolean;
  focusMemberId?: string | null;
}

export const MembersTab: React.FC<MembersTabProps> = ({ members, roomState, currentUser, isHost, focusMemberId }) => {
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [askNameOnJoin, setAskNameOnJoin] = useState(() => !shouldSkipNamePrompt());
  const [newUsernameInput, setNewUsernameInput] = useState(() => currentUser.username);
  const [isChangingRoom, setIsChangingRoom] = useState(false);
  const [customRoomInput, setCustomRoomInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [roomNameInput, setRoomNameInput] = useState(() => roomState?.name || '');
  const [visibilityInput, setVisibilityInput] = useState<RoomVisibility>(() => roomState?.visibility || 'public');
  const [passwordInput, setPasswordInput] = useState('');
  const [autoPauseInput, setAutoPauseInput] = useState(() => Boolean(roomState?.autoPauseOnBuffer));
  const [settingsSaved, setSettingsSaved] = useState(false);

  const focusedRowRef = useRef<HTMLDivElement>(null);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setRoomNameInput(roomState?.name || '');
    setVisibilityInput(roomState?.visibility || 'public');
    setAutoPauseInput(Boolean(roomState?.autoPauseOnBuffer));
  }, [roomState?.name, roomState?.visibility, roomState?.autoPauseOnBuffer]);

  useEffect(() => {
    if (focusMemberId && focusedRowRef.current) {
      focusedRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [focusMemberId]);

  const orderedMembers = sortRoomMembers(members, currentUser.id);
  const bannedMembers = roomState?.bannedMembers || [];

  const handleSaveRoomSettings = (e: React.FormEvent) => {
    e.preventDefault();
    const payload: {
      name?: string;
      visibility?: RoomVisibility;
      password?: string | null;
      autoPauseOnBuffer?: boolean;
    } = {
      name: roomNameInput.trim(),
      visibility: visibilityInput,
      autoPauseOnBuffer: autoPauseInput,
    };
    if (visibilityInput === 'private' && passwordInput.trim()) {
      payload.password = passwordInput.trim();
    }
    syncManager.emitRoomSettings(payload);
    setPasswordInput('');
    setSettingsSaved(true);
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => {
      savedTimerRef.current = null;
      setSettingsSaved(false);
    }, 1800);
  };

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newUsernameInput.trim();
    if (trimmed) {
      try {
        localStorage.setItem('lunio_last_username', trimmed);
      } catch {
        // armazenamento indisponível
      }
      setSkipNamePrompt(!askNameOnJoin);
      syncManager.setUserProfile(trimmed);
    }
    setIsEditingProfile(false);
  };

  const handleJoinCustomRoom = (e: React.FormEvent) => {
    e.preventDefault();
    const code = roomCodeFrom(customRoomInput) || customRoomInput.trim().toUpperCase();
    if (code) {
      // A URL só é atualizada quando o servidor confirmar a entrada na nova sala (App.tsx)
      syncManager.joinRoom(code);
      setIsChangingRoom(false);
      setCustomRoomInput('');
    }
  };

  const handleTransferHost = (memberId: string, name: string) => {
    if (window.confirm(t('Passar o controle da sala para {name}?', { name }))) {
      syncManager.emitTransferHost(memberId);
    }
  };

  const handleKick = (memberId: string, name: string) => {
    if (window.confirm(t('Expulsar {name} da sala?', { name }))) {
      syncManager.emitKick(memberId);
    }
  };

  const handleBan = (memberId: string, name: string) => {
    if (window.confirm(t('Banir {name}? A pessoa não vai conseguir voltar pra esta sala.', { name }))) {
      syncManager.emitBan(memberId);
    }
  };

  const handleUnban = (targetUserId: string, targetUsername: string) => {
    if (window.confirm(t('Desbanir {targetUsername} e permitir que volte pra sala?', { targetUsername }))) {
      syncManager.emitUnban(targetUserId);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-3.5 flex flex-col gap-3.5">
      <div className="flex items-center justify-between text-[13px] text-lu-muted px-0.5">
        <span className="inline-flex items-center gap-2 text-lu-text font-medium">
          {isHost ? <Crown size={15} className="text-lu-accent" /> : <Eye size={15} className="text-lu-muted" />}
          {isHost ? t('Você é o Host') : t('Você é espectador')}
        </span>
        {isHost && (
          <TextButton
            size="sm"
            tone={settingsOpen ? 'accent' : 'muted'}
            onClick={() => setSettingsOpen((v) => !v)}
            className="!h-8 !px-2 text-[12px]"
          >
            <Settings2 size={14} />
            <span>{t('Configurar sala')}</span>
          </TextButton>
        )}
      </div>

      {/* Configurações da sala (somente Host): nome, pública/privada, senha e auto-pause */}
      {isHost && settingsOpen && (
        <form
          onSubmit={handleSaveRoomSettings}
          className="p-3.5 rounded-[14px] bg-lu-surface border border-lu-border flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="room-settings-name" className="text-[12px] font-medium text-lu-muted">
              {t('Nome da sala')}
            </label>
            <TextInput
              id="room-settings-name"
              maxLength={48}
              placeholder={t('Ex.: Maratona de anime')}
              value={roomNameInput}
              onChange={(e) => setRoomNameInput(e.target.value)}
              className="!h-9 text-[13px]"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-lu-muted">{t('Privacidade')}</span>
            <Segmented
              label={t('Privacidade')}
              size="sm"
              value={visibilityInput}
              onChange={(v) => setVisibilityInput(v as RoomVisibility)}
              options={[
                { value: 'public', label: t('Pública'), icon: <Globe size={13} /> },
                { value: 'private', label: t('Privada'), icon: <Lock size={13} /> },
              ]}
            />
          </div>

          {visibilityInput === 'private' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="room-settings-password" className="text-[12px] font-medium text-lu-muted">
                  {t('Senha (opcional)')}
                </label>
                {roomState?.hasPassword && (
                  <button
                    type="button"
                    onClick={() => syncManager.emitRoomSettings({ password: null })}
                    className="text-[11px] font-medium text-lu-error hover:underline bg-transparent border-0 p-0"
                  >
                    {t('Remover senha')}
                  </button>
                )}
              </div>
              <TextInput
                id="room-settings-password"
                type="password"
                maxLength={64}
                placeholder={roomState?.hasPassword ? t('Digite para trocar a senha…') : t('Sem senha = sala trancada')}
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                className="!h-9 text-[13px]"
              />
            </div>
          )}

          <label className="flex items-start gap-2.5 text-[12.5px] text-lu-muted cursor-pointer select-none leading-snug">
            <input
              type="checkbox"
              checked={autoPauseInput}
              onChange={(e) => setAutoPauseInput(e.target.checked)}
              className="w-4 h-4 mt-0.5 m-0 accent-[var(--color-lu-accent)] flex-none"
            />
            <span>{t('Pausar automaticamente se alguém travar carregando')}</span>
          </label>

          <div className="flex items-center justify-end gap-2 pt-0.5">
            {settingsSaved && (
              <span className="inline-flex items-center gap-1 text-[12px] font-medium text-lu-success mr-auto">
                <Check size={14} />
                {t('Salvo')}
              </span>
            )}
            <TextButton size="sm" onClick={() => setSettingsOpen(false)} className="!h-8">
              {t('Fechar')}
            </TextButton>
            <PrimaryButton type="submit" className="!h-8 !px-3.5 text-[12.5px]">
              {t('Salvar')}
            </PrimaryButton>
          </div>
        </form>
      )}

      {/* Seu apelido */}
      <div className="p-3 pl-3.5 rounded-[14px] bg-lu-surface border border-lu-border">
        {isEditingProfile ? (
          <form onSubmit={handleSaveProfile} className="flex flex-col gap-2.5">
            <label htmlFor="wp-username" className="text-[12px] text-lu-muted">
              {t('Seu apelido na sala')}
            </label>
            <TextInput
              id="wp-username"
              maxLength={32}
              value={newUsernameInput}
              onChange={(e) => setNewUsernameInput(e.target.value)}
              autoFocus
            />
            <label className="flex items-center gap-2.5 min-h-10 text-[13px] text-lu-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={askNameOnJoin}
                onChange={(e) => setAskNameOnJoin(e.target.checked)}
                className="w-4 h-4 m-0 accent-[var(--color-lu-accent)]"
              />
              {t('Perguntar o apelido ao criar ou entrar numa sala')}
            </label>
            <div className="flex justify-end gap-2">
              <TextButton size="sm" onClick={() => setIsEditingProfile(false)}>
                {t('Cancelar')}
              </TextButton>
              <PrimaryButton type="submit" disabled={!newUsernameInput.trim()} className="!h-9 !px-4 text-[13px]">
                {t('Salvar')}
              </PrimaryButton>
            </div>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12px] text-lu-muted">{t('Seu apelido na sala')}</div>
              <div className="text-[14px] font-semibold truncate">{currentUser.username}</div>
            </div>
            <TextButton
              tone="text"
              size="sm"
              className="!h-9"
              onClick={() => {
                setNewUsernameInput(currentUser.username);
                setAskNameOnJoin(!shouldSkipNamePrompt());
                setIsEditingProfile(true);
              }}
            >
              <PenLine size={14} />
              {t('Editar')}
            </TextButton>
          </div>
        )}
      </div>

      {/* Contagem + trocar sala */}
      <div className="flex items-center justify-between text-[13px] text-lu-muted">
        <span>
          {orderedMembers.length} {orderedMembers.length === 1 ? t('conectado') : t('conectados')}
        </span>
        <TextButton tone="accent" size="sm" onClick={() => setIsChangingRoom((v) => !v)} className="!font-medium">
          {t('Trocar sala')}
        </TextButton>
      </div>

      {isChangingRoom && (
        <form onSubmit={handleJoinCustomRoom} className="flex gap-2">
          <TextInput
            aria-label={t('Código ou link da sala')}
            placeholder={t('Código ou link da sala')}
            value={customRoomInput}
            onChange={(e) => setCustomRoomInput(e.target.value)}
            className="uppercase tracking-[0.08em]"
            autoFocus
          />
          <PrimaryButton type="submit" disabled={!customRoomInput.trim()} className="!px-4" aria-label={t('Entrar na sala')}>
            <ArrowRight size={18} />
          </PrimaryButton>
        </form>
      )}

      {/* Lista de membros */}
      <div>
        {orderedMembers.map((member) => {
          const isMe = member.id === currentUser.id;
          const isFocused = Boolean(focusMemberId && focusMemberId === member.id);
          const transmitting = memberTransmitting(member, roomState);
          const behind = behindLabel(member, roomState);
          return (
            <div
              key={member.id}
              ref={isFocused ? focusedRowRef : undefined}
              className={cx(
                'flex items-center gap-3 py-2.5 pr-1 border-b border-lu-border transition-colors',
                isFocused && 'bg-lu-tint/50 rounded-[10px] px-2 -mx-2 border-lu-accent/30'
              )}
            >
              <Avatar name={member.username} url={member.avatarUrl} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-medium truncate">{member.username}</span>
                  {isMe && (
                    <span className="text-[11px] text-lu-muted px-1.5 py-px rounded-md bg-lu-elevated flex-none">{t('você')}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap text-[12px] text-lu-muted mt-0.5">
                  {member.isHost ? (
                    <span className="inline-flex items-center gap-1 text-lu-accent font-medium">
                      <Crown size={12} />
                      {t('Host')}
                    </span>
                  ) : (
                    <span>{t('Espectador')}</span>
                  )}
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1.5">
                    <Dot tone={transmitting || member.watchingScreen || member.ready ? 'success' : 'warning'} />
                    {transmitting
                      ? t('Transmitindo')
                      : member.watchingScreen
                        ? t('Assistindo')
                        : member.ready
                          ? t('Sincronizado')
                          : t('Aguardando')}
                  </span>
                  {behind && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-lu-warning font-medium tabular">{behind.text}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span>{member.platform === 'discord' ? 'Discord' : t('Navegador')}</span>
                </div>
              </div>
              {isHost && !isMe && (
                <div className="flex flex-none">
                  <IconButton label={t('Passar Host')} size={36} tone="muted" onClick={() => handleTransferHost(member.id, member.username)}>
                    <Crown size={15} />
                  </IconButton>
                  <IconButton label={t('Expulsar da sala')} size={36} tone="muted" onClick={() => handleKick(member.id, member.username)}>
                    <UserX size={15} />
                  </IconButton>
                  <IconButton label={t('Banir da sala')} size={36} tone="muted" onClick={() => handleBan(member.id, member.username)}>
                    <Ban size={15} />
                  </IconButton>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Banidos */}
      {isHost && bannedMembers.length > 0 && (
        <div className="mt-1">
          <div className="flex items-center gap-2 text-[13px] font-medium mb-2 text-lu-error">
            <Shield size={15} />
            {t('Membros banidos ({n})', { n: bannedMembers.length })}
          </div>
          <div className="flex flex-col gap-2">
            {bannedMembers.map((b) => (
              <div key={b.userId} className="flex items-center gap-3 px-3 py-2.5 rounded-[14px] bg-lu-surface border border-lu-border">
                <Avatar name={b.username} url={b.avatarUrl} size={32} />
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-medium truncate">{b.username}</div>
                  <div className="text-[12px] text-lu-muted">{t('Banido da sala')}</div>
                </div>
                <button
                  type="button"
                  onClick={() => handleUnban(b.userId, b.username)}
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] border border-lu-border text-[13px] font-medium hover:bg-lu-elevated flex-none transition-colors"
                >
                  <UserMinus size={14} />
                  {t('Desbanir')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
