import React, { useState, useEffect, useRef } from 'react';
import {
  Users,
  MessageSquare,
  Crown,
  Share2,
  Check,
  Send,
  X,
  PenLine,
  Eye,
  LogOut,
  UserX,
  Ban,
  UserMinus,
  Shield,
  ArrowDown,
  ArrowRight,
} from 'lucide-react';
import { syncManager } from '../lib/sync';
import { discordManager } from '../lib/discord';
import { roomCodeFrom } from '../lib/roomCode';
import type { RoomState, ChatMessage } from '../types/sync';
import { setSkipNamePrompt, shouldSkipNamePrompt } from './UsernameModal';
import { Avatar, Dot, IconButton, PrimaryButton, TextButton, TextInput, cx } from './ui';

interface WatchPartyPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenRoomLobby?: () => void;
  onRoomMediaTrigger?: (url: string) => void;
  /** Sair da sala (volta para a tela inicial). Sem isso, só desconecta. */
  onLeaveRoom?: () => void;
}

export const WatchPartyPanel: React.FC<WatchPartyPanelProps> = ({ isOpen, onClose, onOpenRoomLobby, onLeaveRoom }) => {
  const [roomState, setRoomState] = useState<RoomState | null>(() => syncManager.getRoomState());
  const [currentUser, setCurrentUser] = useState(() => syncManager.getUser());
  const [activeTab, setActiveTab] = useState<'members' | 'chat'>('chat');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => [...syncManager.getChatHistory()]);
  const [chatInput, setChatInput] = useState<string>('');
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [customRoomInput, setCustomRoomInput] = useState<string>('');
  const [isChangingRoom, setIsChangingRoom] = useState<boolean>(false);
  const [isEditingProfile, setIsEditingProfile] = useState<boolean>(false);
  const [askNameOnJoin, setAskNameOnJoin] = useState<boolean>(() => !shouldSkipNamePrompt());
  const [newUsernameInput, setNewUsernameInput] = useState<string>(() => syncManager.getUser().username);
  const [hasScrolledUp, setHasScrolledUp] = useState<boolean>(false);
  const [newMessagesWhileScrolled, setNewMessagesWhileScrolled] = useState<number>(0);

  const chatListRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef<boolean>(true);
  const discordState = discordManager.getState();

  const handleChatScroll = () => {
    const list = chatListRef.current;
    if (!list) return;
    const isAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 60;
    followingRef.current = isAtBottom;
    setHasScrolledUp(!isAtBottom);
    if (isAtBottom) {
      setNewMessagesWhileScrolled(0);
    }
  };

  const scrollToBottom = (smooth = true) => {
    if (chatListRef.current) {
      chatListRef.current.scrollTo({
        top: chatListRef.current.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
      followingRef.current = true;
      setHasScrolledUp(false);
      setNewMessagesWhileScrolled(0);
    }
  };

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

  useEffect(() => {
    if (activeTab === 'chat' && isOpen) {
      if (followingRef.current) {
        requestAnimationFrame(() => {
          if (chatListRef.current) {
            chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
          }
        });
      } else {
        setNewMessagesWhileScrolled((prev) => prev + 1);
      }
    }
  }, [chatMessages, activeTab, isOpen]);

  useEffect(() => {
    if (activeTab === 'chat' && isOpen) {
      setChatMessages([...syncManager.getChatHistory()]);
      requestAnimationFrame(() => {
        if (chatListRef.current) {
          chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
          followingRef.current = true;
          setHasScrolledUp(false);
          setNewMessagesWhileScrolled(0);
        }
      });
    }
  }, [activeTab, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isHost = syncManager.isRoomHost();
  const isDiscord = discordState.isEmbedded;
  const currentRoomId = syncManager.getRoomId();
  const rawMembers = roomState?.members || [];
  const uniqueMembers = Array.from(new Map(rawMembers.map((m) => [m.id, m])).values());
  const members = uniqueMembers.sort((a, b) => {
    // Host no topo, depois você, depois ordem alfabética
    if (a.isHost && !b.isHost) return -1;
    if (!a.isHost && b.isHost) return 1;
    if (a.id === currentUser.id && b.id !== currentUser.id) return -1;
    if (a.id !== currentUser.id && b.id === currentUser.id) return 1;
    return a.username.localeCompare(b.username);
  });
  const hostId = members.find((m) => m.isHost)?.id;
  // Nome atual de cada pessoa: quem trocou de apelido aparece com o nome novo também nas mensagens antigas
  const nameById = new Map(members.map((m) => [m.id, m.username]));
  const bannedMembers = roomState?.bannedMembers || [];
  const status = syncManager.getStatus();
  const userMessages = chatMessages.filter((m) => !m.isSystem).length;

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
      setCurrentUser(syncManager.getUser());
    }
    setIsEditingProfile(false);
  };

  const handleCopyLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('room', currentRoomId);
    navigator.clipboard.writeText(url.toString()).catch(() => {});
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleSendMessage = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = chatInput.trim();
    if (!text) return;

    syncManager.sendChatMessage(text);
    setChatInput('');
    followingRef.current = true;
    setHasScrolledUp(false);
    setNewMessagesWhileScrolled(0);
    setTimeout(() => scrollToBottom(true), 50);
  };

  const handleJoinCustomRoom = (e: React.FormEvent) => {
    e.preventDefault();
    const code = roomCodeFrom(customRoomInput) || customRoomInput.trim().toUpperCase();
    if (code) {
      syncManager.joinRoom(code);
      setIsChangingRoom(false);
      setCustomRoomInput('');
    }
  };

  const handleTransferHost = (memberId: string, name: string) => {
    if (window.confirm(`Passar o controle da sala para ${name}?`)) {
      syncManager.emitTransferHost(memberId);
    }
  };

  const handleKick = (memberId: string, name: string) => {
    if (window.confirm(`Expulsar ${name} da sala?`)) {
      syncManager.emitKick(memberId);
    }
  };

  const handleBan = (memberId: string, name: string) => {
    if (window.confirm(`Banir ${name}? A pessoa não vai conseguir voltar pra esta sala.`)) {
      syncManager.emitBan(memberId);
    }
  };

  const handleUnban = (targetUserId: string, targetUsername: string) => {
    if (window.confirm(`Desbanir ${targetUsername} e permitir que volte pra sala?`)) {
      syncManager.emitUnban(targetUserId);
    }
  };

  const tabClass = (selected: boolean) =>
    cx(
      'flex-1 inline-flex items-center justify-center gap-2 h-11 border-b-2 text-[13px] transition-colors',
      selected ? 'border-lu-accent text-lu-accent font-semibold' : 'border-transparent text-lu-muted font-medium hover:bg-white/6'
    );

  return (
    <aside
      role="complementary"
      aria-label="Watch Party"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="fixed inset-y-0 right-0 w-full sm:w-[400px] z-50 flex flex-col bg-lu-bg2 sm:border-l border-lu-border shadow-[-24px_0_64px_rgba(0,0,0,0.45)] text-lu-text cursor-auto"
    >
      {/* Cabeçalho */}
      <div className="flex items-center justify-between pl-5 pr-4 py-4 border-b border-lu-border">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h2 className="m-0 text-[16px] font-semibold">Watch Party</h2>
            {status.isConnected ? (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-lu-success">
                <Dot tone="success" />
                Conectado
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-lu-muted">
                <Dot tone="muted" />
                Modo Solo
              </span>
            )}
          </div>
          {status.isConnected && (
            <div className="mt-0.5 text-[13px] text-lu-muted">
              {isDiscord ? (
                'Canal de voz do Discord'
              ) : (
                <>
                  Sala: <span className="text-lu-text font-medium tracking-[0.08em]">{currentRoomId}</span>
                </>
              )}
            </div>
          )}
        </div>
        <IconButton label="Fechar painel" size={40} tone="muted" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>

      {!status.isConnected ? (
        <div className="flex-1 p-6 flex flex-col items-center justify-center text-center gap-4">
          <span className="w-14 h-14 rounded-[14px] bg-lu-tint border border-lu-accent/30 text-lu-accent flex items-center justify-center">
            <Users size={26} />
          </span>
          <div>
            <h3 className="m-0 text-[16px] font-semibold">Você está assistindo sozinho</h3>
            <p className="mt-1.5 mb-0 max-w-[280px] text-[14px] text-lu-muted">
              Crie uma sala pros amigos ou entre em uma com o código que te mandaram.
            </p>
          </div>
          <PrimaryButton
            onClick={() => {
              onClose();
              onOpenRoomLobby?.();
            }}
          >
            <Users size={18} />
            Criar ou entrar em sala
          </PrimaryButton>
        </div>
      ) : (
        <>
          {/* Papel + compartilhar/sair */}
          <div className="flex items-center justify-between pl-5 pr-3 py-2.5 border-b border-lu-border">
            <span className="inline-flex items-center gap-2 text-[13px]">
              {isHost ? <Crown size={16} /> : <Eye size={16} />}
              {isHost ? 'Você é o Host' : 'Você é espectador'}
            </span>
            <div className="flex gap-1">
              <TextButton tone="text" size="sm" onClick={handleCopyLink} className="!h-10">
                {copiedLink ? <Check size={16} className="text-lu-success" /> : <Share2 size={16} />}
                {copiedLink ? 'Link copiado' : 'Compartilhar'}
              </TextButton>
              <TextButton
                size="sm"
                className="!h-10"
                onClick={() => {
                  if (window.confirm('Sair desta sala e voltar para a tela inicial?')) {
                    if (onLeaveRoom) onLeaveRoom();
                    else syncManager.leaveRoom();
                  }
                }}
              >
                <LogOut size={16} />
                Sair
              </TextButton>
            </div>
          </div>

          {/* Abas */}
          <div role="tablist" aria-label="Watch Party" className="flex border-b border-lu-border">
            <button type="button" role="tab" aria-selected={activeTab === 'chat'} onClick={() => setActiveTab('chat')} className={tabClass(activeTab === 'chat')}>
              <MessageSquare size={16} />
              Chat
              {userMessages > 0 && <span className="text-[12px] tabular text-lu-muted">{userMessages}</span>}
            </button>
            <button type="button" role="tab" aria-selected={activeTab === 'members'} onClick={() => setActiveTab('members')} className={tabClass(activeTab === 'members')}>
              <Users size={16} />
              Participantes
              <span className="text-[12px] tabular text-lu-muted">{members.length}</span>
            </button>
          </div>

          {activeTab === 'members' ? (
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 py-4 flex flex-col gap-3.5">
              {/* Seu apelido */}
              <div className="p-3 pl-3.5 rounded-[14px] bg-lu-surface border border-lu-border">
                {isEditingProfile ? (
                  <form onSubmit={handleSaveProfile} className="flex flex-col gap-2.5">
                    <label htmlFor="wp-username" className="text-[12px] text-lu-muted">
                      Seu apelido na sala
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
                      Perguntar o apelido ao criar ou entrar numa sala
                    </label>
                    <div className="flex justify-end gap-2">
                      <TextButton size="sm" onClick={() => setIsEditingProfile(false)}>
                        Cancelar
                      </TextButton>
                      <PrimaryButton type="submit" disabled={!newUsernameInput.trim()} className="!h-9 !px-4 text-[13px]">
                        Salvar
                      </PrimaryButton>
                    </div>
                  </form>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[12px] text-lu-muted">Seu apelido na sala</div>
                      <div className="text-[14px] font-semibold truncate">{currentUser.username}</div>
                    </div>
                    <TextButton
                      tone="text"
                      size="sm"
                      className="!h-10"
                      onClick={() => {
                        setNewUsernameInput(currentUser.username);
                        setAskNameOnJoin(!shouldSkipNamePrompt());
                        setIsEditingProfile(true);
                      }}
                    >
                      <PenLine size={14} />
                      Editar
                    </TextButton>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between text-[13px] text-lu-muted">
                <span>
                  {members.length} {members.length === 1 ? 'conectado' : 'conectados'}
                </span>
                <TextButton tone="accent" size="sm" onClick={() => setIsChangingRoom((v) => !v)} className="!font-medium">
                  Trocar sala
                </TextButton>
              </div>

              {isChangingRoom && (
                <form onSubmit={handleJoinCustomRoom} className="flex gap-2">
                  <TextInput
                    aria-label="Código ou link da sala"
                    placeholder="Código ou link da sala"
                    value={customRoomInput}
                    onChange={(e) => setCustomRoomInput(e.target.value)}
                    className="uppercase tracking-[0.08em]"
                    autoFocus
                  />
                  <PrimaryButton type="submit" disabled={!customRoomInput.trim()} className="!px-4" aria-label="Entrar na sala">
                    <ArrowRight size={18} />
                  </PrimaryButton>
                </form>
              )}

              <div>
                {members.map((member) => {
                  const isMe = member.id === currentUser.id;
                  return (
                    <div key={member.id} className="flex items-center gap-3 py-2.5 pr-1 border-b border-lu-border">
                      <Avatar name={member.username} url={member.avatarUrl} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[14px] font-medium truncate">{member.username}</span>
                          {isMe && (
                            <span className="text-[11px] text-lu-muted px-1.5 py-px rounded-md bg-lu-elevated flex-none">você</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-wrap text-[12px] text-lu-muted mt-0.5">
                          {member.isHost ? (
                            <span className="inline-flex items-center gap-1 text-lu-accent font-medium">
                              <Crown size={12} />
                              Host
                            </span>
                          ) : (
                            <span>Espectador</span>
                          )}
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1.5">
                            <Dot tone={member.ready ? 'success' : 'warning'} />
                            {member.ready ? 'Sincronizado' : 'Aguardando'}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{member.platform === 'discord' ? 'Discord' : 'Navegador'}</span>
                        </div>
                      </div>
                      {isHost && !isMe && (
                        <div className="flex flex-none">
                          <IconButton label="Passar Host" size={40} tone="muted" onClick={() => handleTransferHost(member.id, member.username)}>
                            <Crown size={16} />
                          </IconButton>
                          <IconButton label="Expulsar da sala" size={40} tone="muted" onClick={() => handleKick(member.id, member.username)}>
                            <UserX size={16} />
                          </IconButton>
                          <IconButton label="Banir da sala" size={40} tone="muted" onClick={() => handleBan(member.id, member.username)}>
                            <Ban size={16} />
                          </IconButton>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {isHost && bannedMembers.length > 0 && (
                <div className="mt-2">
                  <div className="flex items-center gap-2 text-[13px] font-medium mb-2 text-lu-error">
                    <Shield size={16} />
                    Membros banidos ({bannedMembers.length})
                  </div>
                  <div className="flex flex-col gap-2">
                    {bannedMembers.map((b) => (
                      <div key={b.userId} className="flex items-center gap-3 px-3 py-2.5 rounded-[14px] bg-lu-surface border border-lu-border">
                        <Avatar name={b.username} url={b.avatarUrl} size={32} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[14px] font-medium truncate">{b.username}</div>
                          <div className="text-[12px] text-lu-muted">Banido da sala</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleUnban(b.userId, b.username)}
                          className="inline-flex items-center gap-1.5 h-10 px-3 rounded-[10px] border border-lu-border text-[13px] font-medium hover:bg-lu-elevated flex-none"
                        >
                          <UserMinus size={14} />
                          Desbanir
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="relative flex-1 min-h-0 flex flex-col">
              <div
                ref={chatListRef}
                onScroll={handleChatScroll}
                aria-live="polite"
                className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 py-4 flex flex-col gap-3"
              >
                {chatMessages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center gap-2 text-lu-muted">
                    <MessageSquare size={28} className="opacity-60" />
                    <p className="m-0 text-[14px]">Nenhuma mensagem ainda.</p>
                    <p className="m-0 text-[12px] text-lu-disabled">Diga oi pra quem está assistindo com você.</p>
                  </div>
                ) : (
                  chatMessages.map((msg) => {
                    if (msg.isSystem) {
                      return (
                        <div key={msg.id} className="text-center text-[12px] text-lu-disabled py-0.5">
                          {msg.text.replace(/\p{Extended_Pictographic}️?\s*/gu, '')}
                        </div>
                      );
                    }

                    const isMe = msg.userId === currentUser.id;
                    const fromHost = msg.userId === hostId;
                    return (
                      <div key={msg.id} className={cx('flex flex-col gap-1', isMe ? 'items-end' : 'items-start')}>
                        <span className="inline-flex items-center gap-1 text-[12px] text-lu-muted px-1">
                          {fromHost && <Crown size={12} aria-label="Host" />}
                          {isMe ? 'Você' : nameById.get(msg.userId) || msg.username}
                        </span>
                        <div
                          className={cx(
                            'max-w-[84%] px-[13px] py-[9px] text-[14px] break-words border',
                            isMe
                              ? 'rounded-[14px_14px_4px_14px] bg-lu-tint border-lu-accent/28'
                              : 'rounded-[14px_14px_14px_4px] bg-lu-elevated border-lu-border'
                          )}
                        >
                          {msg.text}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {hasScrolledUp && (
                <button
                  type="button"
                  onClick={() => scrollToBottom(true)}
                  className="absolute right-4 bottom-[84px] inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] bg-lu-accent text-lu-bg text-[13px] font-semibold shadow-[0_8px_24px_rgba(0,0,0,0.45)] hover:bg-lu-accent-hover"
                >
                  <ArrowDown size={16} />
                  {newMessagesWhileScrolled > 0
                    ? `${newMessagesWhileScrolled} ${newMessagesWhileScrolled === 1 ? 'nova' : 'novas'}`
                    : 'Ir pro fim'}
                </button>
              )}

              <form onSubmit={handleSendMessage} className="flex gap-2 px-4 py-3 border-t border-lu-border">
                <TextInput
                  aria-label="Mensagem"
                  placeholder="Digite uma mensagem…"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  className="flex-1 min-w-0"
                />
                <button
                  type="submit"
                  aria-label="Enviar"
                  disabled={!chatInput.trim()}
                  className="w-11 h-11 flex-none rounded-[10px] inline-flex items-center justify-center bg-lu-accent text-lu-bg hover:bg-lu-accent-hover disabled:opacity-45"
                >
                  <Send size={18} />
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </aside>
  );
};
