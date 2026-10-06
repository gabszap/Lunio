import React, { useEffect, useState } from 'react';
import { ChevronLeft, CircleAlert, CircleCheck, ExternalLink, FileVideo, FolderOpen, Info, Link, Lock, Play, RotateCw, Users, Youtube } from 'lucide-react';
import { getYouTubeId } from '../../lib/media';
import { formatBytes } from '../../lib/recent';
import { BigInput, CardFooter, ClearButton, FieldLabel, GhostButton, Hint, HomeCard, HomeCardTitle, PrimaryButton, Spinner, TextButton } from '../ui';
import type { CommitMode, SourceCommit } from './types';

interface LinkStepProps {
  onBack: () => void;
  onCommit: SourceCommit;
}

const StepActions: React.FC<{ onBack: () => void; onCommit: (mode: CommitMode) => void; disabled?: boolean }> = ({
  onBack,
  onCommit,
  disabled,
}) => (
  <CardFooter>
    <TextButton onClick={onBack} className="!pl-2">
      <ChevronLeft size={18} />
      <span>Voltar</span>
    </TextButton>
    <div className="flex flex-wrap gap-2 justify-end">
      <GhostButton disabled={disabled} onClick={() => onCommit('solo')}>
        <Play size={16} />
        <span>Assistir sozinho</span>
      </GhostButton>
      <PrimaryButton disabled={disabled} onClick={() => onCommit('room')}>
        <Users size={18} />
        <span>Criar sala</span>
      </PrimaryButton>
    </div>
  </CardFooter>
);

// ───────────────────────── YouTube ─────────────────────────

interface YouTubeInfo {
  title: string;
  author: string;
}

export const YouTubeStep: React.FC<LinkStepProps> = ({ onBack, onCommit }) => {
  const [link, setLink] = useState('');
  const [info, setInfo] = useState<YouTubeInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const videoId = getYouTubeId(link);

  useEffect(() => {
    setInfo(null);
    if (!videoId) return;
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, {
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) setInfo({ title: data.title, author: data.author_name });
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [videoId]);

  const invalid = link.trim().length > 8 && !videoId;

  const commit = (mode: CommitMode) => {
    if (!videoId) return;
    onCommit(
      {
        url: `https://www.youtube.com/watch?v=${videoId}`,
        mimeType: 'video/youtube',
        title: info?.title || 'Vídeo do YouTube',
        chapters: [],
        subtitles: [],
        audioTracks: [],
      },
      mode
    );
  };

  return (
    <HomeCard>
      <HomeCardTitle icon={<Youtube size={20} />} title="Abrir vídeo do YouTube" description="Cole o link de um vídeo ou de uma live." />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          commit('room');
        }}
      >
        <FieldLabel htmlFor="yt-link">Link do YouTube</FieldLabel>
        <BigInput
          id="yt-link"
          type="url"
          inputMode="url"
          autoFocus
          placeholder="https://youtu.be/…"
          value={link}
          invalid={invalid}
          aria-describedby={invalid ? 'yt-msg' : undefined}
          onChange={(e) => setLink(e.target.value)}
          icon={<Link size={18} />}
          trailing={link ? <ClearButton onClick={() => setLink('')} /> : undefined}
        />
        {invalid && (
          <Hint id="yt-msg" role="alert" tone="error">
            <CircleAlert size={14} />
            Esse link não parece ser de um vídeo do YouTube.
          </Hint>
        )}

        {videoId && (
          <div className="flex items-center gap-3.5 mt-4 p-3 rounded-[14px] bg-lu-bg2 border border-lu-border">
            <img
              src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`}
              alt=""
              className="w-[120px] sm:w-[160px] aspect-video flex-none rounded-[10px] object-cover bg-lu-elevated border border-lu-border"
            />
            <div className="flex-1 min-w-0 flex flex-col gap-1">
              {loading && !info ? (
                <span className="flex items-center gap-2 text-[13px] text-lu-muted">
                  <Spinner size={14} className="text-lu-accent" />
                  Buscando o vídeo…
                </span>
              ) : (
                <>
                  <span className="text-[14px] font-semibold leading-snug line-clamp-2">{info?.title || 'Vídeo do YouTube'}</span>
                  {info?.author && <span className="text-[12px] text-lu-muted">{info.author}</span>}
                  <span className="flex items-center gap-1.5 text-[12px] text-lu-success mt-0.5">
                    <CircleCheck size={14} />
                    Pronto pra assistir
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        <StepActions onBack={onBack} onCommit={commit} disabled={!videoId} />
      </form>
    </HomeCard>
  );
};

// ───────────────────────── Google Drive ─────────────────────────

interface DriveFile {
  url: string;
  name: string;
  size: number;
  mimeType: string;
}

type DriveState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; file: DriveFile }
  | { kind: 'no_access' }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string };

export const DriveStep: React.FC<LinkStepProps> = ({ onBack, onCommit }) => {
  const [link, setLink] = useState('');
  const [state, setState] = useState<DriveState>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const trimmed = link.trim();
    if (!trimmed) {
      setState({ kind: 'idle' });
      return;
    }
    if (!/drive\.google\.com|docs\.google\.com|^[\w-]{25,}$/.test(trimmed)) {
      setState({ kind: 'invalid' });
      return;
    }
    const controller = new AbortController();
    setState({ kind: 'checking' });
    const timer = window.setTimeout(() => {
      fetch(`/api/drive?url=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then(async (r) => {
          const body = await r.json().catch(() => ({}));
          if (r.ok) setState({ kind: 'ok', file: body });
          else if (body.error === 'no_access') setState({ kind: 'no_access' });
          else if (body.error === 'invalid_link') setState({ kind: 'invalid' });
          else setState({ kind: 'error', message: 'Não deu pra falar com o Google Drive agora.' });
        })
        .catch((err) => {
          if (err?.name !== 'AbortError') setState({ kind: 'error', message: 'Não deu pra falar com o servidor.' });
        });
    }, 350);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [link, attempt]);

  const commit = (mode: CommitMode) => {
    if (state.kind !== 'ok') return;
    const { file } = state;
    onCommit(
      {
        url: file.url,
        mimeType: file.mimeType || 'video/mp4',
        title: file.name.replace(/\.[a-z0-9]+$/i, ''),
        chapters: [],
        subtitles: [],
        audioTracks: [],
        isMkv: /\.mkv$/i.test(file.name),
      },
      mode
    );
  };

  const blocked = state.kind === 'no_access' || state.kind === 'invalid' || state.kind === 'error';

  return (
    <HomeCard>
      <HomeCardTitle icon={<FolderOpen size={20} />} title="Abrir o Google Drive" description="Cole o link de compartilhamento do vídeo." />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          commit('room');
        }}
      >
        <FieldLabel htmlFor="gd-link">Link do Drive</FieldLabel>
        <BigInput
          id="gd-link"
          type="url"
          inputMode="url"
          autoFocus
          placeholder="https://drive.google.com/file/d/…/view"
          value={link}
          invalid={blocked}
          aria-describedby={blocked ? 'gd-msg' : undefined}
          onChange={(e) => setLink(e.target.value)}
          icon={state.kind === 'no_access' ? <Lock size={18} /> : <Link size={18} />}
          trailing={link ? <ClearButton onClick={() => setLink('')} /> : undefined}
        />

        {state.kind === 'checking' && (
          <Hint>
            <Spinner size={14} className="text-lu-accent" />
            Conferindo o arquivo…
          </Hint>
        )}
        {state.kind === 'invalid' && (
          <Hint id="gd-msg" role="alert" tone="error">
            <CircleAlert size={14} />
            Esse não parece ser um link de arquivo do Google Drive.
          </Hint>
        )}
        {state.kind === 'error' && (
          <Hint id="gd-msg" role="alert" tone="error">
            <CircleAlert size={14} />
            {state.message}
          </Hint>
        )}

        {state.kind === 'ok' && (
          <div className="flex items-center gap-3.5 mt-4 px-4 py-3.5 rounded-[14px] bg-lu-bg2 border border-lu-border">
            <span className="text-lu-accent flex">
              <FileVideo size={22} />
            </span>
            <div className="flex-1 min-w-0 flex flex-col">
              <span className="text-[14px] font-semibold truncate">{state.file.name}</span>
              <span className="text-[12px] text-lu-muted tabular">{state.file.size ? formatBytes(state.file.size) : 'Tamanho desconhecido'}</span>
            </div>
            <span className="text-lu-success flex">
              <CircleCheck size={20} />
            </span>
          </div>
        )}

        {state.kind === 'no_access' ? (
          <div id="gd-msg" role="alert" className="mt-4 p-4 rounded-[14px] bg-lu-error/8 border border-lu-error/25">
            <p className="m-0 mb-2.5 flex items-center gap-2 text-[14px] font-semibold text-lu-error">
              <CircleAlert size={18} />
              Sem acesso a esse arquivo
            </p>
            <ol className="m-0 pl-5 flex flex-col gap-1.5 text-[13px] text-lu-muted">
              <li>
                Abra o vídeo no Google Drive e clique em <strong className="text-lu-text font-semibold">Compartilhar</strong>.
              </li>
              <li>
                Em “Acesso geral”, escolha <strong className="text-lu-text font-semibold">Qualquer pessoa com o link</strong>.
              </li>
              <li>Volte aqui e tente de novo.</li>
            </ol>
          </div>
        ) : (
          <div className="flex gap-2.5 mt-3 px-3.5 py-3 rounded-xl bg-lu-blue/8 border border-lu-blue/22 text-[13px] text-lu-muted">
            <span className="flex text-lu-blue mt-px">
              <Info size={16} />
            </span>
            <span>
              O arquivo precisa estar compartilhado como <strong className="text-lu-text font-semibold">“Qualquer pessoa com o link”</strong>.
            </span>
          </div>
        )}

        {state.kind === 'no_access' ? (
          <CardFooter>
            <TextButton onClick={onBack} className="!pl-2">
              <ChevronLeft size={18} />
              <span>Voltar</span>
            </TextButton>
            <div className="flex flex-wrap gap-2 justify-end">
              <a
                href={link.trim()}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 h-11 px-3.5 rounded-[10px] text-[14px] font-medium text-lu-muted no-underline hover:bg-white/8"
              >
                <ExternalLink size={16} />
                <span>Abrir no Drive</span>
              </a>
              <PrimaryButton onClick={() => setAttempt((n) => n + 1)}>
                <RotateCw size={18} />
                <span>Tentar de novo</span>
              </PrimaryButton>
            </div>
          </CardFooter>
        ) : (
          <StepActions onBack={onBack} onCommit={commit} disabled={state.kind !== 'ok'} />
        )}
      </form>
    </HomeCard>
  );
};
