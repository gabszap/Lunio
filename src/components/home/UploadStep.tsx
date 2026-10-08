import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Copy, FileVideo, FolderOpen, Link, Play, Upload, Users, X, Check } from 'lucide-react';
import { formatRoomUrl } from '../../lib/roomCode';
import { copyText, formatBytes } from '../../lib/recent';
import { logger } from '../../lib/logger';
import { waitForRoomToken } from '../../lib/access';
import { BigInput, CardFooter, FieldLabel, GhostButton, HomeCard, HomeCardTitle, PrimaryButton, TextButton, cx } from '../ui';
import type { SourceCommit } from './types';
import type { SourceStep } from './RoomMenu';

const MAX_BYTES = 50 * 1024 ** 3;

interface UploadStepProps {
  onBack: () => void;
  onCommit: SourceCommit;
  /** Cria (ou reaproveita) a sala como Host e devolve o código. */
  ensureRoom: () => string;
  /** Pede o apelido antes de criar a sala, se a aba ainda não tiver um. */
  requireName: (then: () => void) => void;
  onPickSource: (step: SourceStep) => void;
}

type Phase =
  | { kind: 'pick' }
  | { kind: 'chosen'; file: File }
  | { kind: 'too_large'; file: File }
  | { kind: 'uploading'; file: File; loaded: number; speed: number; roomCode: string }
  | { kind: 'done'; file: File; url: string; roomCode: string }
  | { kind: 'error'; file: File; message: string };

export const UploadStep: React.FC<UploadStepProps> = ({ onBack, onCommit, ensureRoom, requireName, onPickSource }) => {
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  /** Invalida um envio que ainda esperava a entrada na sala quando a pessoa cancela. */
  const attemptRef = useRef(0);

  useEffect(
    () => () => {
      attemptRef.current++;
      xhrRef.current?.abort();
    },
    []
  );

  const choose = (file: File | undefined) => {
    if (!file) return;
    setPhase(file.size > MAX_BYTES ? { kind: 'too_large', file } : { kind: 'chosen', file });
  };

  const playLocally = (file: File) => {
    const url = URL.createObjectURL(file);
    const title = file.name.replace(/\.[a-z0-9]+$/i, '');
    logger.info(`[Mídia] Tocando arquivo local, sem enviar: ${file.name}`);
    onCommit(
      { url, mimeType: file.type || 'video/mp4', title, chapters: [], subtitles: [], audioTracks: [] },
      'solo'
    );
  };

  const startUpload = async (file: File) => {
    const roomCode = ensureRoom();
    const attempt = ++attemptRef.current;
    setPhase({ kind: 'uploading', file, loaded: 0, speed: 0, roomCode });

    // O servidor só aceita envio do Host de uma sala ativa: espera a entrada na sala devolver o token
    let token: string;
    try {
      token = await waitForRoomToken(roomCode);
    } catch {
      if (attemptRef.current === attempt) {
        setPhase({ kind: 'error', file, message: 'Não deu pra entrar na sala para enviar. Tente de novo.' });
      }
      return;
    }
    if (attemptRef.current !== attempt) return;

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    const startedAt = performance.now();

    xhr.upload.onprogress = (e) => {
      const elapsed = (performance.now() - startedAt) / 1000;
      setPhase({ kind: 'uploading', file, loaded: e.loaded, speed: elapsed > 0 ? e.loaded / elapsed : 0, roomCode });
    };
    xhr.onload = () => {
      xhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText);
          const absolute = new URL(body.url, window.location.origin).toString();
          logger.info(`[Mídia] Envio concluído: ${file.name}`);
          setPhase({ kind: 'done', file, url: absolute, roomCode });
        } catch {
          setPhase({ kind: 'error', file, message: 'O servidor respondeu de um jeito inesperado.' });
        }
      } else if (xhr.status === 413) {
        setPhase({ kind: 'too_large', file });
      } else {
        // O servidor responde { error: frase em português, code }
        let reason = '';
        try {
          reason = JSON.parse(xhr.responseText)?.error || '';
        } catch {
          // corpo não-JSON
        }
        setPhase({ kind: 'error', file, message: reason || `O envio falhou (HTTP ${xhr.status}).` });
      }
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      setPhase({ kind: 'error', file, message: 'A conexão caiu durante o envio.' });
    };
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Lunio-Token', token);
    xhr.send(file);
  };

  const cancelUpload = () => {
    attemptRef.current++;
    xhrRef.current?.abort();
    xhrRef.current = null;
    setPhase({ kind: 'pick' });
  };

  const openPlayer = () => {
    if (phase.kind !== 'done') return;
    onCommit(
      {
        url: phase.url,
        mimeType: phase.file.type || 'video/mp4',
        title: phase.file.name.replace(/\.[a-z0-9]+$/i, ''),
        chapters: [],
        subtitles: [],
        audioTracks: [],
        isMkv: /\.mkv$/i.test(phase.file.name),
      },
      'room'
    );
  };

  const copyLink = async (code: string) => {
    if (await copyText(formatRoomUrl(code))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept="video/*,.mkv,.mp4,.m4v,.webm,.mov,.avi,.ts"
      className="sr-only"
      tabIndex={-1}
      onChange={(e) => choose(e.target.files?.[0])}
    />
  );

  // ───── Enviando / enviado ─────
  if (phase.kind === 'uploading' || phase.kind === 'done') {
    const total = phase.file.size;
    const loaded = phase.kind === 'done' ? total : phase.loaded;
    const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    const speed = phase.kind === 'uploading' ? phase.speed : 0;
    const eta = speed > 0 ? Math.max(0, (total - loaded) / speed) : 0;
    const etaText = eta < 60 ? 'Falta menos de 1 min' : `Faltam cerca de ${Math.round(eta / 60)} min`;

    return (
      <HomeCard>
        <HomeCardTitle
          icon={<Upload size={20} />}
          title={phase.kind === 'done' ? 'Arquivo enviado' : 'Enviando arquivo'}
          description={
            phase.kind === 'done'
              ? 'Tudo pronto. Abra o player e dê play quando a galera chegar.'
              : 'A sala já existe. Pode mandar o link pra galera enquanto o vídeo sobe.'
          }
        />

        <div className="flex flex-col gap-3 px-4 py-3.5 rounded-[14px] bg-lu-bg2 border border-lu-border">
          <div className="flex items-center gap-3">
            <span className="text-lu-accent flex">
              <FileVideo size={22} />
            </span>
            <div className="flex-1 min-w-0 flex flex-col">
              <span className="text-[14px] font-semibold truncate">{phase.file.name}</span>
              <span className="text-[12px] text-lu-muted tabular">
                {phase.kind === 'done'
                  ? formatBytes(total)
                  : `${formatBytes(loaded)} de ${formatBytes(total)}${speed > 0 ? ` · ${formatBytes(speed)}/s` : ''}`}
              </span>
            </div>
            <span className="text-[20px] font-semibold tabular">{pct}%</span>
          </div>
          <div
            role="progressbar"
            aria-label="Progresso do envio"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 rounded-[3px] bg-lu-elevated overflow-hidden"
          >
            <div className="h-full rounded-[3px] bg-gradient-to-r from-lu-accent-strong to-lu-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          {phase.kind === 'uploading' && (
            <div className="flex justify-between text-[12px] text-lu-muted tabular">
              <span>{speed > 0 ? etaText : 'Calculando…'}</span>
              <span>Não feche esta aba</span>
            </div>
          )}
        </div>

        <FieldLabel htmlFor="up-link" className="mt-5">
          Código da sala
        </FieldLabel>
        <BigInput
          id="up-link"
          readOnly
          code
          value={phase.roomCode}
          icon={<Link size={18} />}
          trailing={
            <button
              type="button"
              onClick={() => copyLink(phase.roomCode)}
              className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg bg-lu-tint text-lu-accent text-[13px] font-semibold hover:bg-lu-accent/20 flex-none"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
              <span>{copied ? 'Copiado' : 'Copiar link'}</span>
            </button>
          }
        />

        <CardFooter>
          {phase.kind === 'uploading' ? (
            <TextButton onClick={cancelUpload}>
              <X size={18} />
              <span>Cancelar envio</span>
            </TextButton>
          ) : (
            <span />
          )}
          <PrimaryButton disabled={phase.kind !== 'done'} onClick={openPlayer}>
            <Play size={16} />
            <span>Abrir player</span>
          </PrimaryButton>
        </CardFooter>
      </HomeCard>
    );
  }

  // ───── Escolher arquivo / grande demais / erro ─────
  const file = phase.kind === 'pick' ? null : phase.file;
  return (
    <HomeCard>
      {fileInput}
      <HomeCardTitle icon={<Upload size={20} />} title="Enviar um arquivo" description="MKV, MP4 e mais · até 50 GB" />

      {!file ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            choose(e.dataTransfer.files?.[0]);
          }}
          className={cx(
            'w-full flex flex-col items-center gap-1.5 px-4 py-8 rounded-[14px] border border-dashed text-lu-text transition-colors',
            dragging ? 'bg-lu-tint border-lu-accent' : 'bg-lu-bg2 border-white/16 hover:bg-lu-elevated'
          )}
        >
          <span className="flex text-lu-accent">
            <Upload size={24} />
          </span>
          <span className="text-[14px] font-semibold">Escolher um vídeo</span>
          <span className="text-[12px] text-lu-muted">ou arraste o arquivo pra cá</span>
        </button>
      ) : (
        <div
          role={phase.kind === 'chosen' ? undefined : 'alert'}
          className={cx(
            'flex items-center gap-3.5 px-4 py-3.5 rounded-[14px] border',
            phase.kind === 'chosen' ? 'bg-lu-bg2 border-lu-border' : 'bg-lu-error/6 border-lu-error/35'
          )}
        >
          <span className={cx('flex', phase.kind === 'chosen' ? 'text-lu-accent' : 'text-lu-error')}>
            <FileVideo size={22} />
          </span>
          <div className="flex-1 min-w-0 flex flex-col">
            <span className="text-[14px] font-semibold truncate">{file.name}</span>
            <span className={cx('text-[13px] tabular', phase.kind === 'chosen' ? 'text-lu-muted' : 'text-lu-error')}>
              {phase.kind === 'too_large'
                ? `${formatBytes(file.size)} · passa do limite de 50 GB`
                : phase.kind === 'error'
                ? phase.message
                : formatBytes(file.size)}
            </span>
          </div>
          <button
            type="button"
            aria-label="Remover arquivo"
            onClick={() => setPhase({ kind: 'pick' })}
            className="w-10 h-10 rounded-lg inline-flex items-center justify-center text-lu-muted hover:bg-white/8 flex-none"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {phase.kind === 'too_large' && (
        <>
          <p className="mt-5 mb-2.5 text-[13px] font-semibold">Pra arquivos grandes, tente:</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { step: 'drive' as const, label: 'Google Drive', icon: <FolderOpen size={18} /> },
              { step: 'stream' as const, label: 'Link de stream', icon: <Link size={18} /> },
            ].map((alt) => (
              <button
                key={alt.step}
                type="button"
                onClick={() => onPickSource(alt.step)}
                className="flex items-center gap-3 min-h-16 px-3.5 rounded-[14px] bg-lu-bg2 border border-lu-border hover:bg-white/6 text-left w-full"
              >
                <span className="w-9 h-9 rounded-[10px] bg-lu-elevated text-lu-accent flex items-center justify-center flex-none">{alt.icon}</span>
                <span className="text-[14px] font-semibold">{alt.label}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {phase.kind === 'chosen' && (
        <p className="mt-3 mb-0 text-[12px] text-lu-muted">
          Pra assistir com amigos o arquivo sobe pro servidor. Sozinho, ele toca direto daqui, sem enviar nada.
        </p>
      )}

      <CardFooter>
        <TextButton onClick={onBack} className="!pl-2">
          <ChevronLeft size={18} />
          <span>Voltar</span>
        </TextButton>
        <div className="flex flex-wrap gap-2 justify-end">
          {phase.kind === 'chosen' ? (
            <>
              <GhostButton onClick={() => playLocally(phase.file)}>
                <Play size={16} />
                <span>Assistir sozinho</span>
              </GhostButton>
              <PrimaryButton onClick={() => requireName(() => startUpload(phase.file))}>
                <Users size={18} />
                <span>Enviar e criar sala</span>
              </PrimaryButton>
            </>
          ) : phase.kind === 'error' ? (
            <PrimaryButton onClick={() => requireName(() => startUpload(phase.file))}>
              <Upload size={18} />
              <span>Tentar de novo</span>
            </PrimaryButton>
          ) : (
            <GhostButton onClick={() => inputRef.current?.click()}>
              <Upload size={18} />
              <span>{file ? 'Escolher outro arquivo' : 'Procurar no computador'}</span>
            </GhostButton>
          )}
        </div>
      </CardFooter>
    </HomeCard>
  );
};
