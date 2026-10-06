import React, { useEffect, useState } from 'react';
import { ArrowRight, ChevronLeft, CircleAlert, CircleX, Link, LogIn, Plus } from 'lucide-react';
import { roomCodeFrom } from '../../lib/roomCode';
import { BigInput, CardFooter, ClearButton, FieldLabel, GhostButton, Hint, HomeCard, HomeCardTitle, PrimaryButton, Spinner, TextButton } from '../ui';

export type JoinError = 'invalid' | 'not_found' | 'closed';

export interface RoomCheck {
  exists: boolean;
  closed: boolean;
  members: number;
}

/** Pergunta ao servidor se a sala existe. `null` = servidor não respondeu (segue o fluxo antigo e entra mesmo assim). */
export async function checkRoom(code: string): Promise<RoomCheck | null> {
  try {
    const r = await fetch(`/api/room?id=${encodeURIComponent(code)}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ───────────────────────── Entrar na sala ─────────────────────────

interface JoinStepProps {
  initialCode?: string;
  initialError?: JoinError | null;
  onBack: () => void;
  onJoin: (code: string) => void;
  onCreate: () => void;
}

const ERROR_TEXT: Record<Exclude<JoinError, 'closed'>, string> = {
  invalid: 'Isso não parece um código de sala. Cole o link que te mandaram ou só o código de 8 caracteres.',
  not_found: 'Não achamos essa sala. Confira o código ou peça um link novo pra quem criou.',
};

export const JoinStep: React.FC<JoinStepProps> = ({ initialCode = '', initialError = null, onBack, onJoin, onCreate }) => {
  const [value, setValue] = useState(initialCode);
  const [error, setError] = useState<JoinError | null>(initialError);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setValue(initialCode);
    setError(initialError);
  }, [initialCode, initialError]);

  const submit = async () => {
    const code = roomCodeFrom(value);
    if (!code) {
      setError('invalid');
      return;
    }
    setChecking(true);
    const info = await checkRoom(code);
    setChecking(false);
    if (info && !info.exists) {
      setError(info.closed ? 'closed' : 'not_found');
      return;
    }
    onJoin(code);
  };

  if (error === 'closed') {
    const code = roomCodeFrom(value) || value;
    return (
      <HomeCard center className="!max-w-[480px]">
        <span className="w-14 h-14 rounded-2xl bg-lu-error/12 text-lu-error flex items-center justify-center">
          <CircleX size={28} />
        </span>
        <h1 className="mt-4 mb-0 text-[22px] sm:text-[24px] font-semibold tracking-[-0.02em] leading-tight">Essa sala foi encerrada</h1>
        <p className="mt-1.5 mb-2 text-[14px] text-lu-muted">
          O Host fechou a sala <strong className="text-lu-text font-semibold tracking-[0.08em]">{code}</strong>. Peça um link novo ou crie a sua.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 mt-5 w-full">
          <GhostButton
            className="flex-1"
            onClick={() => {
              setValue('');
              setError(null);
            }}
          >
            <LogIn size={18} />
            <span>Entrar em outra</span>
          </GhostButton>
          <PrimaryButton className="flex-1" onClick={onCreate}>
            <Plus size={18} />
            <span>Criar uma sala</span>
          </PrimaryButton>
        </div>
      </HomeCard>
    );
  }

  return (
    <HomeCard>
      <HomeCardTitle icon={<LogIn size={20} />} title="Entrar na sala" description="Quem criou a sala te passa o link ou o código." />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <FieldLabel htmlFor="room-code">Link ou código da sala</FieldLabel>
        <BigInput
          id="room-code"
          autoFocus
          code={!/[/:.]/.test(value)}
          placeholder="ABCD1234"
          autoComplete="off"
          spellCheck={false}
          value={value}
          invalid={Boolean(error)}
          aria-describedby="room-code-msg"
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          icon={<Link size={18} />}
          trailing={value ? <ClearButton onClick={() => setValue('')} /> : undefined}
        />
        {error ? (
          <Hint id="room-code-msg" role="alert" tone="error" className="!items-start !text-[13px]">
            <span className="flex mt-px">
              <CircleAlert size={16} />
            </span>
            <span>{ERROR_TEXT[error]}</span>
          </Hint>
        ) : (
          <Hint id="room-code-msg">Cole o link da sala ou só o código de 8 caracteres.</Hint>
        )}

        <CardFooter>
          <TextButton onClick={onBack} className="!pl-2">
            <ChevronLeft size={18} />
            <span>Voltar</span>
          </TextButton>
          <PrimaryButton type="submit" disabled={!value.trim() || checking}>
            {checking ? <Spinner size={18} /> : <ArrowRight size={18} />}
            <span>{error ? 'Tentar de novo' : 'Entrar'}</span>
          </PrimaryButton>
        </CardFooter>
      </form>
    </HomeCard>
  );
};
