import React, { useEffect, useState } from 'react';
import { Crown, Link as LinkIcon, LogIn, Play, Users, CircleAlert } from 'lucide-react';
import { generateRoomCode, roomCodeFrom } from '../lib/roomCode';
import { BigInput, FieldLabel, Hint, Modal, ModalHeader, PrimaryButton, Segmented, TextInput } from './ui';
import { t } from '../lib/i18n';

interface RoomLobbyModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialRoomId?: string | null;
  onJoinRoom: (roomId: string, username: string) => void;
  onCreateRoom: (roomId: string, username: string) => void;
  onSoloMode: () => void;
  currentUsername?: string;
}

const isPlaceholderName = (name: string) => !name || name.startsWith('Espectador #') || name === 'Usuário Local';

/** "Watch Party · Sala": criar uma sala (vira Host) ou entrar em uma existente, a partir do player. */
export const RoomLobbyModal: React.FC<RoomLobbyModalProps> = ({
  isOpen,
  onClose,
  initialRoomId,
  onJoinRoom,
  onCreateRoom,
  onSoloMode,
  currentUsername = '',
}) => {
  const [activeTab, setActiveTab] = useState<'create' | 'join'>('create');
  const [joinCode, setJoinCode] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setError('');
    setUsername(isPlaceholderName(currentUsername) ? '' : currentUsername);
    if (initialRoomId) {
      setActiveTab('join');
      setJoinCode(initialRoomId);
    }
  }, [isOpen, initialRoomId, currentUsername]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    if (activeTab === 'create') {
      onCreateRoom(generateRoomCode(), name);
      return;
    }
    const code = roomCodeFrom(joinCode);
    if (!code) {
      setError(t('Isso não parece um código de sala. Cole o link ou o código de 8 caracteres.'));
      return;
    }
    onJoinRoom(code, name);
  };

  return (
    <Modal open={isOpen} onClose={onClose} label={t('Watch Party')}>
      <ModalHeader title={t('Watch Party')} description={t('Crie uma sala para seus amigos ou entre em uma existente.')} onClose={onClose} />

      <Segmented
        label={t('Criar ou entrar')}
        value={activeTab}
        onChange={(v) => {
          setActiveTab(v as 'create' | 'join');
          setError('');
        }}
        options={[
          { value: 'create', label: t('Criar sala'), icon: <Crown size={16} /> },
          { value: 'join', label: t('Entrar em sala'), icon: <LogIn size={16} /> },
        ]}
      />

      <form onSubmit={submit} className="flex flex-col gap-5">
        {activeTab === 'join' && (
          <div>
            <FieldLabel htmlFor="join-code" className="!font-medium">
              {t('Link ou código da sala')}
            </FieldLabel>
            <BigInput
              id="join-code"
              code
              placeholder="ABCD1234"
              autoComplete="off"
              value={joinCode}
              invalid={Boolean(error)}
              onChange={(e) => {
                setJoinCode(e.target.value);
                setError('');
              }}
              icon={<LinkIcon size={18} />}
            />
            {error && (
              <Hint role="alert" tone="error">
                <CircleAlert size={14} />
                {error}
              </Hint>
            )}
          </div>
        )}

        <div>
          <FieldLabel htmlFor="lobby-username" className="!font-medium">
            {t('Como você quer ser chamado?')}
          </FieldLabel>
          <TextInput
            id="lobby-username"
            maxLength={32}
            placeholder={t('Digite seu nome ou apelido…')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <p className="mt-2 mb-0 text-[12px] text-lu-muted">{t('Se deixar vazio, geramos um nome de visitante para você.')}</p>
        </div>

        {activeTab === 'create' && (
          <p className="-mt-2 mb-0 text-[13px] text-lu-muted">
            {t('Você será o Host e controlará a reprodução e a seleção de mídia. O código da sala é gerado ao criar.')}
          </p>
        )}

        <PrimaryButton type="submit" size="lg" block>
          {activeTab === 'create' ? <Users size={18} /> : <LogIn size={18} />}
          <span>{activeTab === 'create' ? t('Criar sala e iniciar') : t('Entrar na sala')}</span>
        </PrimaryButton>
      </form>

      <div className="h-px bg-lu-border -mx-7" />
      <button
        type="button"
        onClick={onSoloMode}
        className="w-full inline-flex items-center justify-center gap-2 h-11 -my-1.5 rounded-[10px] text-[14px] font-medium text-lu-muted hover:bg-white/6"
      >
        <Play size={16} />
        {t('Assistir sozinho')}
      </button>
    </Modal>
  );
};
