import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Crown, MessageSquare } from 'lucide-react';
import { t } from '../../lib/i18n';
import { syncManager } from '../../lib/sync';
import type { ChatMessage, RoomMember } from '../../types/sync';
import { cx } from '../ui';

const FOLLOW_SLACK_PX = 60;

export interface ChatTabProps {
  messages: ChatMessage[];
  members: RoomMember[];
  currentUserId: string;
  active: boolean;
}

export const ChatTab: React.FC<ChatTabProps> = ({ messages, members, currentUserId, active }) => {
  const [chatInput, setChatInput] = useState('');
  const [hasScrolledUp, setHasScrolledUp] = useState(false);
  const [newMessagesWhileScrolled, setNewMessagesWhileScrolled] = useState(0);

  const chatListRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const prevCountRef = useRef(messages.length);
  const wasActiveRef = useRef(active);

  const handleChatScroll = () => {
    const list = chatListRef.current;
    if (!list) return;
    const isAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_SLACK_PX;
    followingRef.current = isAtBottom;
    setHasScrolledUp(!isAtBottom);
    if (isAtBottom) {
      setNewMessagesWhileScrolled(0);
    }
  };

  const scrollToBottom = (smooth = true) => {
    const list = chatListRef.current;
    if (!list) return;
    list.scrollTo({
      top: list.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
    followingRef.current = true;
    setHasScrolledUp(false);
    setNewMessagesWhileScrolled(0);
  };

  // Ao abrir ou voltar para a aba Chat, cola no fim imediatamente.
  useEffect(() => {
    if (active && !wasActiveRef.current) {
      requestAnimationFrame(() => {
        if (chatListRef.current) {
          chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
          followingRef.current = true;
          setHasScrolledUp(false);
          setNewMessagesWhileScrolled(0);
        }
      });
      prevCountRef.current = messages.length;
    }
    wasActiveRef.current = active;
  }, [active, messages.length]);

  // Montagem inicial com a aba já ativa: garante posição no final.
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      if (chatListRef.current) {
        chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
        followingRef.current = true;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Acompanha mensagens novas automaticamente se o usuário estiver no fim; caso contrário conta não lidas.
  useEffect(() => {
    const delta = messages.length - prevCountRef.current;
    prevCountRef.current = messages.length;
    if (!active || delta <= 0) return;

    if (followingRef.current) {
      requestAnimationFrame(() => {
        if (chatListRef.current) {
          chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
        }
      });
    } else {
      setNewMessagesWhileScrolled((prev) => prev + delta);
    }
  }, [messages.length, active]);

  const hostId = members.find((m) => m.isHost)?.id;
  // Nome atual de cada pessoa: quem trocou de apelido aparece com o nome novo também nas mensagens antigas.
  const nameById = new Map(members.map((m) => [m.id, m.username]));

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text) return;

    syncManager.sendChatMessage(text);
    setChatInput('');
    followingRef.current = true;
    setHasScrolledUp(false);
    setNewMessagesWhileScrolled(0);
    setTimeout(() => scrollToBottom(true), 50);
  };

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={chatListRef}
        onScroll={handleChatScroll}
        aria-live="polite"
        className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-3.5 flex flex-col gap-3"
      >
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 text-lu-muted">
            <MessageSquare size={26} className="opacity-60" />
            <p className="m-0 text-[14px]">{t('Nenhuma mensagem ainda.')}</p>
            <p className="m-0 text-[12px] text-lu-disabled">{t('Diga oi pra quem está assistindo com você.')}</p>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.isSystem) {
              return (
                <div key={msg.id} className="text-center text-[12px] text-lu-disabled py-0.5">
                  {msg.text.replace(/\p{Extended_Pictographic}\uFE0F?\s*/gu, '')}
                </div>
              );
            }

            const isMe = msg.userId === currentUserId;
            const fromHost = msg.userId === hostId;
            return (
              <div key={msg.id} className={cx('flex flex-col gap-1', isMe ? 'items-end' : 'items-start')}>
                <span className="inline-flex items-center gap-1 text-[12px] text-lu-muted px-1">
                  {fromHost && <Crown size={12} aria-label={t('Host')} />}
                  {isMe ? t('Você') : nameById.get(msg.userId) || msg.username}
                </span>
                <div
                  className={cx(
                    'max-w-[85%] px-[13px] py-[8px] text-[13.5px] leading-[1.4] break-words border',
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
          className="absolute right-3.5 bottom-[68px] inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-lu-accent text-lu-bg text-[12px] font-semibold shadow-[0_8px_24px_rgba(0,0,0,0.45)] hover:bg-lu-accent-hover transition-colors"
        >
          <ArrowDown size={14} />
          {newMessagesWhileScrolled > 0
            ? newMessagesWhileScrolled === 1
              ? t('{n} nova', { n: 1 })
              : t('{n} novas', { n: newMessagesWhileScrolled })
            : t('Ir pro fim')}
        </button>
      )}

      <form onSubmit={handleSendMessage} className="px-3 py-2.5 border-t border-lu-border">
        <div className="relative">
          <input
            type="text"
            aria-label={t('Mensagem')}
            placeholder={t('Digite uma mensagem…')}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            className="w-full h-10 box-border pl-3.5 pr-12 rounded-[12px] bg-lu-bg border border-lu-border text-lu-text font-[inherit] text-[13.5px] focus:border-lu-accent/60 focus-visible:outline-none transition-colors"
          />
          <button
            type="submit"
            aria-label={t('Enviar')}
            title={t('Enviar')}
            disabled={!chatInput.trim()}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full inline-flex items-center justify-center bg-lu-accent text-lu-bg hover:bg-lu-accent-hover disabled:opacity-35 disabled:hover:bg-lu-accent transition-colors"
          >
            <ArrowUp size={16} strokeWidth={2.2} />
          </button>
        </div>
      </form>
    </div>
  );
};
