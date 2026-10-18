import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Copy, FileVideo, FolderOpen, History, Link, Play, Upload, Users, X, Check } from 'lucide-react';
import { formatRoomUrl } from '../../lib/roomCode';
import { copyText, formatBytes } from '../../lib/recent';
import { forgetRecentUpload, loadRecentUploads, rememberRecentUpload, type RecentUpload } from '../../lib/recentUploads';
import { logger } from '../../lib/logger';
import { getAccessToken, waitForRoomToken } from '../../lib/access';
import { UploadError, uploadInChunks, type UploadSession } from '../../lib/chunkedUpload';
import { BigInput, CardFooter, FieldLabel, GhostButton, HomeCard, HomeCardTitle, PrimaryButton, TextButton, cx } from '../ui';
import type { SourceCommit } from './types';
import type { SourceStep } from './RoomMenu';
import { apiErrorMessage, t } from '../../lib/i18n';

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
  | { kind: 'uploading'; file: File; loaded: number; speed: number; roomCode: string; retrying?: boolean }
  | { kind: 'reopening'; rec: RecentUpload }
  | { kind: 'done'; file: File; url: string; roomCode: string }
  | { kind: 'error'; file: File; message: string }
  | { kind: 'reopen_error'; rec: RecentUpload; message: string };

export const UploadStep: React.FC<UploadStepProps> = ({ onBack, onCommit, ensureRoom, requireName, onPickSource }) => {
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  /** "Seus envios recentes": o que este navegador enviou e pode reabrir (localStorage). */
  const [recent, setRecent] = useState<RecentUpload[]>(() => loadRecentUploads());
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Sessão de envio no servidor: guardada para "Continuar o envio" retomar de onde parou. */
  const sessionRef = useRef<UploadSession | null>(null);
  /** Invalida um envio que ainda esperava a entrada na sala quando a pessoa cancela. */
  const attemptRef = useRef(0);

  useEffect(
    () => () => {
      attemptRef.current++;
      abortRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    if (phase.kind === 'pick') setRecent(loadRecentUploads());
  }, [phase.kind]);

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
        setPhase({ kind: 'error', file, message: t('Não deu pra entrar na sala para enviar. Tente de novo.') });
      }
      return;
    }
    if (attemptRef.current !== attempt) return;

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const startedAt = performance.now();
    let startedFrom = -1;

    try {
      const result = await uploadInChunks({
        file,
        signal: ctrl.signal,
        getToken: getAccessToken,
        session: sessionRef.current,
        onSession: (s) => {
          sessionRef.current = s;
        },
        onProgress: (loaded, resumedFrom) => {
          if (attemptRef.current !== attempt) return;
          if (startedFrom < 0) startedFrom = resumedFrom;
          const elapsed = (performance.now() - startedAt) / 1000;
          const speed = elapsed > 0.5 ? Math.max(0, loaded - startedFrom) / elapsed : 0;
          setPhase((prev) => (prev.kind === 'uploading' ? { ...prev, loaded, speed } : prev));
        },
        onRetry: (waiting) => {
          if (attemptRef.current !== attempt) return;
          setPhase((prev) => (prev.kind === 'uploading' ? { ...prev, retrying: waiting } : prev));
        },
      });
      if (attemptRef.current !== attempt) return;
      abortRef.current = null;
      sessionRef.current = null;
      logger.info(`[Mídia] Envio concluído: ${file.name}`);
      // A prova de dono vai pro localStorage: é o que permite "reabrir" este arquivo depois
      rememberRecentUpload({ id: result.id, name: result.name, size: result.size, claim: result.claim, at: Date.now() });
      setRecent(loadRecentUploads());
      setPhase({ kind: 'done', file, url: new URL(result.url, window.location.origin).toString(), roomCode });
    } catch (err) {
      abortRef.current = null;
      if ((err as Error)?.name === 'AbortError' || attemptRef.current !== attempt) return;
      if (err instanceof UploadError && err.status === 413) {
        sessionRef.current = null;
        setPhase({ kind: 'too_large', file });
        return;
      }
      if (err instanceof UploadError && err.status === 0) {
        setPhase({ kind: 'error', file, message: t('A conexão caiu durante o envio.') });
        return;
      }
      // O servidor responde { error: frase em português, code }
      const reason = err instanceof UploadError ? apiErrorMessage(err.code, err.message) : '';
      if (err instanceof UploadError && (err.status === 404 || err.status === 403)) sessionRef.current = null;
      setPhase({ kind: 'error', file, message: reason || t('O envio falhou (HTTP {status}).', { status: err instanceof UploadError ? err.status : 0 }) });
    }
  };

  /** Descarta o que já subiu: avisa o servidor (apaga o arquivo parcial) e esquece a sessão. */
  const discardSession = () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      void fetch(`/api/upload/${session.id}`, { method: 'DELETE', headers: { 'X-Lunio-Token': getAccessToken() } }).catch(() => {});
    }
  };

  const cancelUpload = () => {
    attemptRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    discardSession();
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

  /** Reabrir um envio de antes: entra na sala (como host) e apresenta o `claim` de dono ao servidor. */
  const reopenUpload = async (rec: RecentUpload) => {
    const attempt = ++attemptRef.current;
    setPhase({ kind: 'reopening', rec });
    const roomCode = ensureRoom();
    let token: string;
    try {
      token = await waitForRoomToken(roomCode);
    } catch {
      if (attemptRef.current === attempt) {
        setPhase({ kind: 'reopen_error', rec, message: t('Não deu pra entrar na sala para reabrir o envio. Tente de novo.') });
      }
      return;
    }
    if (attemptRef.current !== attempt) return;
    let res: Response;
    try {
      res = await fetch('/api/uploads/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lunio-Token': token },
        body: JSON.stringify({ id: rec.id, claim: rec.claim }),
      });
    } catch {
      if (attemptRef.current === attempt) {
        setPhase({ kind: 'reopen_error', rec, message: t('A conexão caiu antes de reabrir. Tente de novo.') });
      }
      return;
    }
    if (attemptRef.current !== attempt) return;
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      // o servidor já apagou o envio (prazo vencido): desaparece da lista e volta à escolha
      if (res.status === 404 && body?.code === 'claim_not_found') {
        forgetRecentUpload(rec.id);
        setRecent(loadRecentUploads());
        setPhase({ kind: 'pick' });
        return;
      }
      setPhase({ kind: 'reopen_error', rec, message: apiErrorMessage(body?.code, body?.error) || t('Não foi possível reabrir o envio.') });
      return;
    }
    logger.info(`[Mídia] Envio reaberto: ${body.name ?? rec.name}`);
    const stub = new File([], body.name ?? rec.name, { type: 'video/mp4', lastModified: rec.at }); // só nome/tipo; o conteúdo está no servidor
    setPhase({ kind: 'done', file: stub, url: new URL(body.url, window.location.origin).toString(), roomCode });
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
    const etaText = eta < 60 ? t('Falta menos de 1 min') : t('Faltam cerca de {v1} min', { v1: Math.round(eta / 60) });

    return (
      <HomeCard>
        <HomeCardTitle
          icon={<Upload size={20} />}
          title={phase.kind === 'done' ? t('Arquivo enviado') : t('Enviando arquivo')}
          description={
            phase.kind === 'done'
              ? t('Tudo pronto. Abra o player e dê play quando a galera chegar.')
              : t('A sala já existe. Pode mandar o link pra galera enquanto o vídeo sobe.')
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
            aria-label={t('Progresso do envio')}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 rounded-[3px] bg-lu-elevated overflow-hidden"
          >
            <div className="h-full rounded-[3px] bg-gradient-to-r from-lu-accent-strong to-lu-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          {phase.kind === 'uploading' && (
            <div className="flex justify-between text-[12px] text-lu-muted tabular">
              <span>{phase.retrying ? t('Reconectando…') : speed > 0 ? etaText : t('Calculando…')}</span>
              <span>{t('Não feche esta aba')}</span>
            </div>
          )}
        </div>

        <FieldLabel htmlFor="up-link" className="mt-5">
          {t('Código da sala')}
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
              <span>{copied ? t('Copiado') : t('Copiar link')}</span>
            </button>
          }
        />

        <CardFooter>
          {phase.kind === 'uploading' ? (
            <TextButton onClick={cancelUpload}>
              <X size={18} />
              <span>{t('Cancelar envio')}</span>
            </TextButton>
          ) : (
            <span />
          )}
          <PrimaryButton disabled={phase.kind !== 'done'} onClick={openPlayer}>
            <Play size={16} />
            <span>{t('Abrir player')}</span>
          </PrimaryButton>
        </CardFooter>
      </HomeCard>
    );
  }

  // ───── Reabrindo um envio de antes ─────
  if (phase.kind === 'reopening') {
    return (
      <HomeCard>
        <HomeCardTitle
          icon={<History size={20} />}
          title={t('Reabrindo o arquivo')}
          description={t('Entrando na sala e recuperando o envio que você fez antes.')}
        />
        <div className="flex items-center gap-3 px-4 py-3.5 rounded-[14px] bg-lu-bg2 border border-lu-border">
          <span className="text-lu-accent flex">
            <FileVideo size={22} />
          </span>
          <div className="flex-1 min-w-0 flex flex-col">
            <span className="text-[14px] font-semibold truncate">{phase.rec.name}</span>
            <span className="text-[12px] text-lu-muted tabular">{formatBytes(phase.rec.size)}</span>
          </div>
        </div>
        <CardFooter>
          <TextButton
            onClick={() => {
              attemptRef.current++;
              setPhase({ kind: 'pick' });
            }}
          >
            <X size={18} />
            <span>{t('Cancelar')}</span>
          </TextButton>
          <span />
        </CardFooter>
      </HomeCard>
    );
  }

  // ───── Escolher arquivo / grande demais / erro ─────
  const file = 'file' in phase ? phase.file : null;
  return (
    <HomeCard>
      {fileInput}
      <HomeCardTitle icon={<Upload size={20} />} title={t('Enviar um arquivo')} description={t('MKV, MP4 e mais · até 50 GB')} />

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
          <span className="text-[14px] font-semibold">{t('Escolher um vídeo')}</span>
          <span className="text-[12px] text-lu-muted">{t('ou arraste o arquivo pra cá')}</span>
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
                ? t('{v1} · passa do limite de 50 GB', { v1: formatBytes(file.size) })
                : phase.kind === 'error'
                ? phase.message
                : formatBytes(file.size)}
            </span>
          </div>
          <button
            type="button"
            aria-label={t('Remover arquivo')}
            onClick={() => {
              discardSession();
              setPhase({ kind: 'pick' });
            }}
            className="w-10 h-10 rounded-lg inline-flex items-center justify-center text-lu-muted hover:bg-white/8 flex-none"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {phase.kind === 'reopen_error' && (
        <div
          role="alert"
          className="flex items-center gap-3.5 px-4 py-3.5 rounded-[14px] border bg-lu-error/6 border-lu-error/35"
        >
          <span className="flex text-lu-error">
            <FileVideo size={22} />
          </span>
          <div className="flex-1 min-w-0 flex flex-col">
            <span className="text-[14px] font-semibold truncate">{phase.rec.name}</span>
            <span className="text-[13px] text-lu-error">{phase.message}</span>
          </div>
          <button
            type="button"
            aria-label={t('Remover da lista')}
            onClick={() => {
              forgetRecentUpload(phase.rec.id);
              setRecent(loadRecentUploads());
            }}
            className="w-10 h-10 rounded-lg inline-flex items-center justify-center text-lu-muted hover:bg-white/8 flex-none"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {phase.kind === 'pick' && recent.length > 0 && (
        <div className="mt-4 flex flex-col gap-1.5">
          <span className="mt-1 text-[13px] font-semibold">{t('Seus envios recentes')}</span>
          {recent.map((rec) => (
            <div key={rec.id} className="flex items-center gap-3 px-3.5 py-2.5 rounded-[12px] bg-lu-bg2 border border-lu-border">
              <span className="flex text-lu-accent flex-none">
                <FileVideo size={18} />
              </span>
              <div className="flex-1 min-w-0 flex flex-col">
                <span className="text-[13px] font-semibold truncate">{rec.name}</span>
                <span className="text-[12px] text-lu-muted tabular">{formatBytes(rec.size)}</span>
              </div>
              <GhostButton onClick={() => requireName(() => reopenUpload(rec))} className="flex-none">
                <History size={16} />
                <span>{t('Usar este arquivo')}</span>
              </GhostButton>
            </div>
          ))}
        </div>
      )}

      {phase.kind === 'too_large' && (
        <>
          <p className="mt-5 mb-2.5 text-[13px] font-semibold">{t('Pra arquivos grandes, tente:')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { step: 'drive' as const, label: t('Google Drive'), icon: <FolderOpen size={18} /> },
              { step: 'stream' as const, label: t('Link de stream'), icon: <Link size={18} /> },
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
          {t('Pra assistir com amigos o arquivo sobe pro servidor. Sozinho, ele toca direto daqui, sem enviar nada.')}
        </p>
      )}

      <CardFooter>
        <TextButton onClick={onBack} className="!pl-2">
          <ChevronLeft size={18} />
          <span>{t('Voltar')}</span>
        </TextButton>
        <div className="flex flex-wrap gap-2 justify-end">
          {phase.kind === 'chosen' ? (
            <>
              <GhostButton onClick={() => playLocally(phase.file)}>
                <Play size={16} />
                <span>{t('Assistir sozinho')}</span>
              </GhostButton>
              <PrimaryButton onClick={() => requireName(() => startUpload(phase.file))}>
                <Users size={18} />
                <span>{t('Enviar e criar sala')}</span>
              </PrimaryButton>
            </>
          ) : phase.kind === 'error' ? (
            <PrimaryButton onClick={() => requireName(() => startUpload(phase.file))}>
              <Upload size={18} />
              <span>{sessionRef.current ? t('Continuar o envio') : t('Tentar de novo')}</span>
            </PrimaryButton>
          ) : phase.kind === 'reopen_error' ? (
            <PrimaryButton onClick={() => requireName(() => reopenUpload(phase.rec))}>
              <History size={18} />
              <span>{t('Usar este arquivo')}</span>
            </PrimaryButton>
          ) : (
            <GhostButton onClick={() => inputRef.current?.click()}>
              <Upload size={18} />
              <span>{file ? t('Escolher outro arquivo') : t('Procurar no computador')}</span>
            </GhostButton>
          )}
        </div>
      </CardFooter>
    </HomeCard>
  );
};
