import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  CircleAlert,
  CircleX,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Link,
  Lock,
  LogIn,
  Plus,
  Tv,
  User,
} from 'lucide-react';
import {
  BigInput,
  ClearButton,
  FieldLabel,
  GhostButton,
  Hint,
  HomeCard,
  PrimaryButton,
  Segmented,
  Spinner,
  TextButton,
  TextInput,
  cx,
} from '../ui';
import { getLastUsername, setSkipNamePrompt } from '../UsernameModal';
import { syncManager } from '../../lib/sync';
import { roomCodeFrom } from '../../lib/roomCode';
import { msg, t } from '../../lib/i18n';
import type { RoomVisibility } from '../../types/sync';
import { checkRoom, type JoinError } from './RoomSteps';

export interface CreateRoomInput {
  name: string;
  visibility: RoomVisibility;
  password?: string;
}

export interface RoomEntryCardProps {
  initialMode?: 'create' | 'join';
  joinPrefill?: { code: string; error: JoinError | null };
  onCreateRoom: (input: CreateRoomInput) => void;
  onJoinRoom: (code: string) => void;
  onCatalog: () => void;
  onClearJoinPrefill?: () => void;
}

type EntryMode = 'create' | 'join';

const LAST_NAME_KEY = 'lunio_last_username';

const MODE_OPTIONS: Array<{ value: EntryMode; label: string; icon: React.ReactNode }> = [
  { value: 'create', label: msg('Criar sala'), icon: <Plus size={16} /> },
  { value: 'join', label: msg('Entrar com código'), icon: <LogIn size={16} /> },
];

const VISIBILITY_OPTIONS: Array<{
  value: RoomVisibility;
  title: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    value: 'public',
    title: msg('Sala pública'),
    description: msg('Visível na listagem de salas'),
    icon: <Globe size={20} />,
  },
  {
    value: 'private',
    title: msg('Sala privada'),
    description: msg('Só entra quem tiver o link'),
    icon: <Lock size={20} />,
  },
];

const JOIN_ERROR_TEXT: Record<Exclude<JoinError, 'closed'>, string> = {
  invalid: msg('Isso não parece um código de sala. Cole o link que te mandaram ou só o código de 8 caracteres.'),
  not_found: msg('Não achamos essa sala. Confira o código ou peça um link novo pra quem criou.'),
};

function readInitialNickname(): string {
  return getLastUsername() || (syncManager.hasCustomUsername() ? syncManager.getUser().username : '');
}

export const RoomEntryCard: React.FC<RoomEntryCardProps> = ({
  initialMode = 'create',
  joinPrefill,
  onCreateRoom,
  onJoinRoom,
  onCatalog,
  onClearJoinPrefill,
}) => {
  const [mode, setMode] = useState<EntryMode>(() =>
    joinPrefill?.code || joinPrefill?.error ? 'join' : initialMode
  );

  // Identidade inline
  const [savedName, setSavedName] = useState<string>(readInitialNickname);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  // Fluxo "Criar sala"
  const [visibility, setVisibility] = useState<RoomVisibility>('public');
  const [roomName, setRoomName] = useState('');
  const [roomNameError, setRoomNameError] = useState(false);
  const [roomPassword, setRoomPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const roomNameRef = useRef<HTMLInputElement>(null);

  // Fluxo "Entrar com código"
  const [joinValue, setJoinValue] = useState(joinPrefill?.code ?? '');
  const [joinError, setJoinError] = useState<JoinError | null>(joinPrefill?.error ?? null);
  const [checkingJoin, setCheckingJoin] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (joinPrefill?.code || joinPrefill?.error) {
      setMode('join');
      setJoinValue(joinPrefill.code || '');
      setJoinError(joinPrefill.error ?? null);
    }
  }, [joinPrefill?.code, joinPrefill?.error]);

  const startEditName = () => {
    setNameDraft(savedName);
    setEditingName(true);
  };

  const cancelEditName = () => {
    setEditingName(false);
    setNameDraft('');
  };

  const saveInlineName = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = nameDraft.trim().slice(0, 25);
    if (!clean) return;
    try {
      localStorage.setItem(LAST_NAME_KEY, clean);
    } catch {
      // armazenamento indisponível
    }
    setSkipNamePrompt(true);
    syncManager.setUserProfile(clean);
    setSavedName(clean);
    setEditingName(false);
  };

  const handleModeChange = (next: EntryMode) => {
    setMode(next);
    if (next === 'create' && (joinPrefill?.code || joinPrefill?.error || joinError === 'closed')) {
      setJoinError(null);
      onClearJoinPrefill?.();
    }
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = roomName.trim();
    if (!cleanName) {
      setRoomNameError(true);
      roomNameRef.current?.focus();
      return;
    }
    const cleanPassword = visibility === 'private' ? roomPassword.trim() : '';
    onCreateRoom({
      name: cleanName.slice(0, 48),
      visibility,
      ...(cleanPassword ? { password: cleanPassword.slice(0, 64) } : {}),
    });
  };

  const handleJoinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (checkingJoin) return;
    const code = roomCodeFrom(joinValue);
    if (!code) {
      setJoinError('invalid');
      return;
    }
    setCheckingJoin(true);
    const info = await checkRoom(code);
    if (!mountedRef.current) return;
    setCheckingJoin(false);
    if (info && !info.exists) {
      setJoinError(info.closed ? 'closed' : 'not_found');
      return;
    }
    onJoinRoom(code);
  };

  const handleResetClosed = () => {
    setJoinValue('');
    setJoinError(null);
    onClearJoinPrefill?.();
  };

  const handleCreateFromClosed = () => {
    setJoinValue('');
    setJoinError(null);
    onClearJoinPrefill?.();
    setMode('create');
  };

  const handleVisibilityKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      setVisibility((prev) => (prev === 'public' ? 'private' : 'public'));
    }
  };

  return (
    <HomeCard>
      <div>
        <h2 className="m-0 text-[20px] sm:text-[22px] font-semibold tracking-[-0.02em] leading-tight text-lu-text">
          {t('Criar ou entrar em uma sala')}
        </h2>
        <p className="mt-1.5 mb-0 text-[13.5px] sm:text-[14px] text-lu-muted">
          {t('Dê um nome para a sala e chame a galera pelo link.')}
        </p>
      </div>

      {/* Identidade inline */}
      <div className="mt-4 px-3.5 py-2.5 rounded-xl bg-lu-bg2 border border-lu-border">
        {editingName ? (
          <form onSubmit={saveInlineName} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <TextInput
              maxLength={25}
              autoFocus
              autoComplete="nickname"
              aria-label={t('Seu apelido na sala')}
              placeholder={t('Seu apelido na sala')}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancelEditName();
              }}
              className="flex-1 min-w-0 !h-10 !bg-lu-bg"
            />
            <div className="flex items-center gap-2 flex-none">
              <PrimaryButton type="submit" disabled={!nameDraft.trim()} className="flex-1 sm:flex-none !h-10 !px-3.5 text-[13px]">
                {t('Salvar')}
              </PrimaryButton>
              <GhostButton type="button" onClick={cancelEditName} className="flex-1 sm:flex-none !h-10 !px-3 text-[13px]">
                {t('Cancelar')}
              </GhostButton>
            </div>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-3 flex-wrap min-h-[28px]">
            <div className="flex items-center gap-2 min-w-0 text-[13px] text-lu-muted">
              <User size={15} className="flex-none text-lu-muted" />
              {savedName ? (
                <span className="truncate">
                  {t('Usando nome')}{' '}
                  <strong className="text-lu-text font-semibold">{savedName}</strong>
                </span>
              ) : (
                <span>{t('Sem apelido definido')}</span>
              )}
            </div>
            <button
              type="button"
              onClick={startEditName}
              className="appearance-none bg-transparent border-0 p-1 rounded-md text-[13px] font-medium text-lu-accent hover:text-lu-accent-hover underline underline-offset-4 transition-colors flex-none"
            >
              {savedName ? t('Trocar') : t('Definir nome')}
            </button>
          </div>
        )}
      </div>

      {/* Alternador Criar sala / Entrar com código */}
      <Segmented
        label={t('Criar ou entrar')}
        value={mode}
        onChange={handleModeChange}
        options={MODE_OPTIONS}
        className="mt-5"
      />

      {mode === 'create' ? (
        <form onSubmit={handleCreateSubmit} noValidate className="mt-5 flex flex-col gap-5">
          {/* Seletor de Privacidade */}
          <div>
            <span className="block text-[13px] font-semibold mb-2 text-lu-text">{t('Privacidade')}</span>
            <div
              role="radiogroup"
              aria-label={t('Privacidade da sala')}
              className="grid grid-cols-1 sm:grid-cols-2 gap-3"
            >
              {VISIBILITY_OPTIONS.map((opt) => {
                const selected = visibility === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setVisibility(opt.value)}
                    onKeyDown={handleVisibilityKeyDown}
                    className={cx(
                      'relative flex flex-col items-center text-center gap-2 p-4 rounded-[14px] border transition-colors',
                      selected
                        ? 'border-lu-accent/70 bg-lu-accent/[0.08]'
                        : 'border-lu-border bg-lu-bg2 hover:border-lu-border-strong'
                    )}
                  >
                    {selected && (
                      <span
                        aria-hidden="true"
                        className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full bg-lu-accent text-lu-bg flex items-center justify-center"
                      >
                        <Check size={12} strokeWidth={2.75} />
                      </span>
                    )}
                    <span
                      className={cx(
                        'w-10 h-10 rounded-[10px] flex items-center justify-center transition-colors',
                        selected ? 'bg-lu-tint text-lu-accent' : 'bg-lu-elevated text-lu-muted'
                      )}
                    >
                      {opt.icon}
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="text-[14px] font-semibold text-lu-text">{t(opt.title)}</span>
                      <span className="text-[12px] text-lu-muted leading-snug">{t(opt.description)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Nome da sala (obrigatório) */}
          <div>
            <FieldLabel htmlFor="home-room-name">{t('Nome da sala')}</FieldLabel>
            <BigInput
              ref={roomNameRef}
              id="home-room-name"
              maxLength={48}
              autoComplete="off"
              placeholder={t('Ex.: Maratona de anime')}
              value={roomName}
              invalid={roomNameError}
              aria-describedby={roomNameError ? 'home-room-name-err' : undefined}
              onChange={(e) => {
                setRoomName(e.target.value);
                if (roomNameError) setRoomNameError(false);
              }}
              icon={<Tv size={18} />}
              trailing={
                roomName ? (
                  <ClearButton
                    label={t('Limpar')}
                    onClick={() => {
                      setRoomName('');
                      roomNameRef.current?.focus();
                    }}
                  />
                ) : undefined
              }
            />
            {roomNameError && (
              <Hint id="home-room-name-err" role="alert" tone="error" className="!items-start !text-[13px]">
                <span className="flex mt-px">
                  <CircleAlert size={16} />
                </span>
                <span>{t('Dê um nome para a sala antes de criar.')}</span>
              </Hint>
            )}
          </div>

          {/* Senha condicional (privada) */}
          {visibility === 'private' && (
            <div>
              <FieldLabel htmlFor="home-room-password">{t('Senha (opcional)')}</FieldLabel>
              <BigInput
                id="home-room-password"
                type={showPassword ? 'text' : 'password'}
                maxLength={64}
                autoComplete="new-password"
                placeholder={t('Deixe vazio para entrar só com o link')}
                value={roomPassword}
                onChange={(e) => setRoomPassword(e.target.value)}
                icon={<KeyRound size={18} />}
                trailing={
                  <button
                    type="button"
                    aria-label={showPassword ? t('Ocultar') : t('Mostrar')}
                    title={showPassword ? t('Ocultar') : t('Mostrar')}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="appearance-none inline-flex items-center justify-center flex-none w-10 h-10 rounded-lg text-lu-muted hover:text-lu-text hover:bg-white/8 transition-colors"
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                }
              />
            </div>
          )}

          <PrimaryButton size="lg" block type="submit">
            <span>{t('Criar sala')}</span>
            <ArrowRight size={18} />
          </PrimaryButton>
        </form>
      ) : joinError === 'closed' ? (
        <div className="mt-5 py-4 flex flex-col items-center text-center">
          <span className="w-12 h-12 rounded-2xl bg-lu-error/12 text-lu-error flex items-center justify-center">
            <CircleX size={24} />
          </span>
          <h3 className="mt-3.5 mb-0 text-[18px] font-semibold tracking-[-0.01em] text-lu-text">
            {t('Essa sala foi encerrada')}
          </h3>
          <p className="mt-1.5 mb-0 text-[13.5px] text-lu-muted max-w-[380px]">
            {t('O Host fechou a sala')}{' '}
            <strong className="text-lu-text font-semibold tracking-[0.08em]">
              {roomCodeFrom(joinValue) || joinValue}
            </strong>
            {t('. Peça um link novo ou crie a sua.')}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 mt-5 w-full">
            <GhostButton className="flex-1" onClick={handleResetClosed}>
              <LogIn size={18} />
              <span>{t('Entrar em outra')}</span>
            </GhostButton>
            <PrimaryButton className="flex-1" onClick={handleCreateFromClosed}>
              <Plus size={18} />
              <span>{t('Criar uma sala')}</span>
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <form onSubmit={handleJoinSubmit} className="mt-5 flex flex-col gap-5">
          <div>
            <FieldLabel htmlFor="room-code">{t('Link ou código da sala')}</FieldLabel>
            <BigInput
              id="room-code"
              autoFocus
              code={!/[/:.]/.test(joinValue)}
              placeholder="ABCD1234"
              autoComplete="off"
              spellCheck={false}
              value={joinValue}
              invalid={Boolean(joinError)}
              aria-describedby="room-code-msg"
              onChange={(e) => {
                setJoinValue(e.target.value);
                if (joinError) setJoinError(null);
              }}
              icon={<Link size={18} />}
              trailing={
                joinValue ? (
                  <ClearButton
                    label={t('Limpar')}
                    onClick={() => {
                      setJoinValue('');
                      setJoinError(null);
                    }}
                  />
                ) : undefined
              }
            />
            {joinError ? (
              <Hint id="room-code-msg" role="alert" tone="error" className="!items-start !text-[13px]">
                <span className="flex mt-px">
                  <CircleAlert size={16} />
                </span>
                <span>{t(JOIN_ERROR_TEXT[joinError])}</span>
              </Hint>
            ) : (
              <Hint id="room-code-msg">{t('Cole o link da sala ou só o código de 8 caracteres.')}</Hint>
            )}
          </div>

          <PrimaryButton size="lg" block type="submit" disabled={!joinValue.trim() || checkingJoin}>
            {checkingJoin ? <Spinner size={18} /> : <ArrowRight size={18} />}
            <span>{t('Entrar na sala')}</span>
          </PrimaryButton>
        </form>
      )}

      {/* Rodapé discreto */}
      <div className="mt-6 pt-4 border-t border-lu-border flex items-center justify-center">
        <TextButton tone="accent" onClick={onCatalog} className="group">
          <span>{t('Explorar o catálogo')}</span>
          <ArrowRight size={16} className="transition-transform duration-150 group-hover:translate-x-0.5" />
        </TextButton>
      </div>
    </HomeCard>
  );
};
