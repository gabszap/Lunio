import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { SkipVoteState } from '../../types/sync';
import type { Chapter } from '../../types/media';
import type { SkippableChapterInfo } from '../../lib/chapters';
import { formatTime } from '../../lib/chapters';
import { logger } from '../../lib/logger';
import { syncManager } from '../../lib/sync';
import { t } from '../../lib/i18n';

/**
 * Pular abertura/encerramento/resumo em sala e o pulo automático da abertura.
 *
 * - Quem tem o controle (Host ou quem assiste sozinho) pula direto pelo botão.
 * - Espectador vota; passando de metade da sala, o servidor avisa o Host e o player dele faz o seek (a sala o segue).
 * - Com "pular abertura e encerramento sozinho" ligado: ao entrar num deles, uma contagem de 5 s; no fim, quem tem o
 *   controle pula e o espectador vota. Qualquer tecla cancela (Tab pula já). Vale uma vez por capítulo de cada vídeo.
 */
/** Quanto o player espera antes de pular sozinho (dá tempo de cancelar com qualquer tecla). */
export const AUTO_SKIP_DELAY_MS = 5000;

export function useSkipVote(args: {
  skippableChapter: SkippableChapterInfo | null;
  /** Capítulos do vídeo (já normalizados): o Host os informa à sala para o servidor validar os votos. */
  chapters: Chapter[];
  isViewer: boolean;
  /** Conectado a uma sala (os capítulos só vão para a sala depois de conectar). */
  isConnected: boolean;
  autoSkipIntro: boolean;
  sourceSrc: string;
  lastKnownTimeRef: MutableRefObject<number>;
  handleSeekRef: MutableRefObject<(time: number) => void>;
  triggerOsdToast: (text: string, icon?: string) => void;
}) {
  const { skippableChapter, chapters, isViewer, isConnected, autoSkipIntro, sourceSrc, lastKnownTimeRef, handleSeekRef, triggerOsdToast } = args;
  const [skipVote, setSkipVote] = useState<SkipVoteState | null>(() => syncManager.getSkipVote());

  useEffect(() => syncManager.subscribeSkipVote(setSkipVote), []);

  // Host: informa os capítulos à sala (de novo ao reconectar ou ao virar Host)
  const chaptersKey = JSON.stringify(chapters.map((c) => [c.startTime, c.endTime, c.title]));
  useEffect(() => {
    if (isViewer || chapters.length === 0) return;
    syncManager.emitChapters(sourceSrc, chapters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaptersKey, sourceSrc, isViewer, isConnected]);

  // O Host recebe "a sala aprovou pular": confere que o vídeo ainda está naquele capítulo e faz o seek
  useEffect(
    () =>
      syncManager.subscribeSkipPassed((start, target) => {
        const now = lastKnownTimeRef.current;
        if (now < start - 0.5 || now >= target) return;
        logger.action(`[Sala] A sala votou: pulando para ${formatTime(target)}`);
        handleSeekRef.current(target);
        triggerOsdToast(t('A sala votou para pular'));
      }),
    [lastKnownTimeRef, handleSeekRef, triggerOsdToast]
  );

  const selfId = syncManager.getUser().id.replace(/_tab\d{4}$/, '');
  const chapterVote = skippableChapter && skipVote && Math.abs(skipVote.start - skippableChapter.startTime) < 0.5 ? skipVote : null;
  const voted = Boolean(isViewer && chapterVote?.voters.includes(selfId));

  /** Espectador: vota (ou retira o voto) para pular o capítulo de agora. */
  const toggleVote = useCallback(() => {
    if (!isViewer || !skippableChapter) return;
    syncManager.emitSkipVote(skippableChapter.startTime, skippableChapter.targetTime, !voted);
  }, [isViewer, skippableChapter, voted]);

  // Pulo automático da abertura e do encerramento: contagem de 5 s; Tab pula já e qualquer outra tecla cancela
  const handledRef = useRef('');
  const [autoSkipIn, setAutoSkipIn] = useState<number | null>(null);
  const chapterStart = skippableChapter?.startTime;
  const chapterTarget = skippableChapter?.targetTime;
  const chapterType = skippableChapter?.type;
  useEffect(() => {
    const auto = autoSkipIntro && (chapterType === 'op' || chapterType === 'ed') && chapterStart !== undefined && chapterTarget !== undefined;
    if (!auto) {
      setAutoSkipIn(null);
      return;
    }
    const key = `${sourceSrc}#${chapterStart}`;
    // Uma vez por capítulo de cada vídeo: pulou ou foi cancelado, não repete (voltar o vídeo depois não dispara de novo)
    if (handledRef.current === key) return;

    const label = chapterType === 'op' ? t('Abertura pulada') : t('Encerramento pulado');
    const deadline = Date.now() + AUTO_SKIP_DELAY_MS;
    let finished = false;
    const finish = () => {
      finished = true;
      handledRef.current = key;
      setAutoSkipIn(null);
      window.clearInterval(interval);
      window.removeEventListener('keydown', onKey, true);
    };
    const run = () => {
      finish();
      if (isViewer) {
        syncManager.emitSkipVote(chapterStart as number, chapterTarget as number, true);
        triggerOsdToast(t('Voto para pular enviado'));
      } else {
        logger.action(`[Player] ${label} automaticamente → ${formatTime(chapterTarget as number)}`);
        handleSeekRef.current(chapterTarget as number);
        triggerOsdToast(label);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      // Só teclas de modificador (Alt+Tab, por exemplo) não cancelam; Tab é o próprio atalho de pular (o player já o trata)
      if (finished || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      finish();
      if (e.key !== 'Tab') triggerOsdToast(t('Pulo automático cancelado'));
    };
    const interval = window.setInterval(() => {
      const left = deadline - Date.now();
      if (left <= 0) run();
      else setAutoSkipIn(Math.ceil(left / 1000));
    }, 250);
    setAutoSkipIn(Math.ceil(AUTO_SKIP_DELAY_MS / 1000));
    window.addEventListener('keydown', onKey, true);
    return () => {
      if (!finished) {
        window.clearInterval(interval);
        window.removeEventListener('keydown', onKey, true);
        setAutoSkipIn(null);
      }
    };
  }, [autoSkipIntro, chapterType, chapterStart, chapterTarget, sourceSrc, isViewer, handleSeekRef, triggerOsdToast]);

  return {
    /** Votos do capítulo de agora (null se ninguém votou ou for outro capítulo). */
    chapterVote,
    voted,
    toggleVote,
    /** Segundos que faltam para o pulo automático (null = sem contagem). */
    autoSkipIn,
  };
}
