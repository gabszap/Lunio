import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { syncManager } from '../lib/sync';
import { Modal, PrimaryButton, TextInput } from './ui';

const LAST_NAME_KEY = 'lunio_last_username';
const SKIP_PROMPT_KEY = 'lunio_skip_name_prompt';

export function getLastUsername(): string {
  try {
    return localStorage.getItem(LAST_NAME_KEY) || '';
  } catch {
    return '';
  }
}

/** A pessoa marcou "Não perguntar de novo" e há um apelido salvo para usar direto. */
export function shouldSkipNamePrompt(): boolean {
  try {
    return localStorage.getItem(SKIP_PROMPT_KEY) === 'true' && Boolean(getLastUsername());
  } catch {
    return false;
  }
}

export function setSkipNamePrompt(skip: boolean) {
  try {
    if (skip) localStorage.setItem(SKIP_PROMPT_KEY, 'true');
    else localStorage.removeItem(SKIP_PROMPT_KEY);
  } catch {
    // armazenamento indisponível
  }
}

interface UsernameModalProps {
  isOpen: boolean;
  /** Chamado com o apelido escolhido (já salvo no syncManager). */
  onUsernameSet: (username: string) => void;
  onClose?: () => void;
  /** Texto do botão principal: "Entrar na sala" ou "Criar sala". */
  actionLabel?: string;
}

/** "Modal · Apelido": pedido de apelido antes de criar ou entrar numa sala. */
export const UsernameModal: React.FC<UsernameModalProps> = ({ isOpen, onUsernameSet, onClose, actionLabel = 'Entrar na sala' }) => {
  const [name, setName] = useState('');
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const guestName = useMemo(() => {
    const current = syncManager.getUser().username;
    return current.startsWith('Espectador #') ? current : `Espectador #${Math.floor(1000 + Math.random() * 9000)}`;
  }, [isOpen]);

  // Preenche com o último apelido usado (a identidade é por aba, mas o nome a pessoa quase sempre repete)
  useEffect(() => {
    if (!isOpen) return;
    setName(getLastUsername());
    setDontAskAgain(false);
  }, [isOpen]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    try {
      localStorage.setItem(LAST_NAME_KEY, clean);
    } catch {
      // armazenamento indisponível
    }
    setSkipNamePrompt(dontAskAgain);
    syncManager.setUserProfile(clean);
    onUsernameSet(clean);
  };

  const asGuest = () => {
    syncManager.setUserProfile(guestName);
    onUsernameSet(guestName);
  };

  return (
    <Modal open={isOpen} onClose={onClose} label="Escolha seu apelido" width={400} className="text-center">
      <div>
        <h2 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">Como você quer ser chamado?</h2>
        <p className="mt-2 mx-auto mb-0 max-w-[300px] text-[14px] text-lu-muted">
          Escolha um apelido para sincronizar a reprodução e conversar no chat da Watch Party.
        </p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3 text-left">
        <label htmlFor="invite-username" className="text-[13px] font-medium">
          Seu apelido na sala
        </label>
        <TextInput
          id="invite-username"
          maxLength={25}
          autoComplete="nickname"
          placeholder="Ex.: Marina"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="flex items-center gap-2.5 min-h-11 text-[13px] text-lu-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
            className="w-4 h-4 m-0 accent-[var(--color-lu-accent)]"
          />
          Não perguntar de novo (usar este apelido sempre)
        </label>
        <PrimaryButton type="submit" size="lg" block disabled={!name.trim()}>
          <ArrowRight size={18} />
          <span>{actionLabel}</span>
        </PrimaryButton>
        <button
          type="button"
          onClick={asGuest}
          className="w-full h-11 rounded-[10px] text-[13px] font-medium text-lu-muted hover:bg-white/6"
        >
          Continuar como convidado ({guestName})
        </button>
      </form>
    </Modal>
  );
};
