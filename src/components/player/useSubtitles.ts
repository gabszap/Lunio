import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import type { AudioTrackOption, PlaybackReadiness, ResolvedMediaRef, SubtitleTrack } from '../../types/media';
import { logger } from '../../lib/logger';
import { subtitleManager, subtitleResolver } from '../../lib/subtitles';
import { getVideoElement } from './dom';

/**
 * Legendas do player: faixas detectadas, a escolhida (local, nunca vai para a sala), preparação (JASSUB/nativa),
 * gating de legenda obrigatória, "Tentar a próxima" pelo ranking e "Assistir sem legenda".
 */
export function useSubtitles(args: {
  playerRef: RefObject<MediaPlayerInstance | null>;
  audioOffsetRef: MutableRefObject<number>;
  setPaused: Dispatch<SetStateAction<boolean>>;
  initialSubtitles: SubtitleTrack[];
}) {
  const { playerRef, audioOffsetRef, setPaused, initialSubtitles } = args;

  const [detectedSubtitles, setDetectedSubtitles] = useState<SubtitleTrack[]>(initialSubtitles);

  // PlaybackReadiness (v8): Controle preciso de prontidão (vídeo + áudio + legenda obrigatória)
  const [readiness, setReadiness] = useState<PlaybackReadiness>({
    video: false,
    audio: false,
    selectedSubtitle: {
      enabled: false,
      required: false,
      ready: true,
    },
  });
  const readinessRef = useRef(readiness);
  readinessRef.current = readiness;
  const [isPreparingSubtitle, setIsPreparingSubtitle] = useState<boolean>(false);

  const [activeSubtitle, setActiveSubtitle] = useState<SubtitleTrack | null>(null);

  // Prompt flutuante para erro/fallback de legenda obrigatória (Gating v8)
  const [subtitleFailurePrompt, setSubtitleFailurePrompt] = useState<{
    track: SubtitleTrack;
    error: string;
    code?: string;
  } | null>(null);
  // Faixas que já falharam (por ID da candidata, não por URL) e a ordem do ranking da resolução atual
  const failedSubtitleIdsRef = useRef<Set<string>>(new Set());
  const rankedSubtitleIdsRef = useRef<string[]>([]);
  const subtitleKey = (s: SubtitleTrack) => s.id || s.src;

  /** Zera o estado de falhas/ranking quando a fonte de vídeo muda. */
  const resetSubtitleState = () => {
    setSubtitleFailurePrompt(null);
    failedSubtitleIdsRef.current.clear();
    rankedSubtitleIdsRef.current = [];
  };

  /** Resolve as candidatas (embutidas + externas), guarda o ranking e escolhe a melhor. */
  const applyResolvedSubtitles = async (resolvedMedia: ResolvedMediaRef, audios: AudioTrackOption[], isCancelled: () => boolean) => {
  // Resolução desacoplada de legendas via SubtitleResolver (descoberta paralela + ranking determinístico v8)
  const { candidates, rankedCandidates, topCandidate } = await subtitleResolver.resolveCandidates(resolvedMedia, {
    preferredLanguages: ['pt-br', 'por', 'pt', 'en'],
    preferAssForAnime: true,
    requireSubtitle: true,
  });

  if (isCancelled()) return;

  if (candidates.length > 0) {
    // Preserva a ordem original das faixas do container (stream index) na lista do menu
    const subs: SubtitleTrack[] = candidates.map((c) => subtitleResolver.candidateToTrack(c));
    setDetectedSubtitles(subs);
    // O "Tentar a próxima" segue o ranking, não a ordem das faixas no container
    rankedSubtitleIdsRef.current = rankedCandidates.map((c) => c.id);

    const topTrack = topCandidate
      ? (subs.find((s) => s.id === topCandidate.id) || subs[0])
      : subs[0];

    // Avalia se legenda é estritamente obrigatória antes de iniciar reprodução
    const isJapanese = audios.some((a) => a.language?.includes('jpn') || a.label.toLowerCase().includes('japon'));
    const isPortugueseAudio = audios.some((a) => a.language?.includes('por') || a.label.toLowerCase().includes('portug'));
    const isRequired = isJapanese || !isPortugueseAudio;

    setReadiness((prev) => ({
      ...prev,
      selectedSubtitle: {
        enabled: true,
        required: isRequired,
        ready: false,
        candidateId: topTrack.id,
      },
    }));

    setActiveSubtitle(topTrack);
    logger.info(`[Legenda] Escolhida automaticamente: ${topTrack.label}`);
  } else {
    setDetectedSubtitles(initialSubtitles);
    setReadiness((prev) => ({
      ...prev,
      selectedSubtitle: {
        enabled: false,
        required: false,
        ready: true,
      },
    }));
  }
  };

  /** Fonte sem inspeção (arquivo local etc.): usa só as legendas informadas. */
  const applyLocalSubtitles = () => {
    setDetectedSubtitles(initialSubtitles);
    const defaultTrack = initialSubtitles.find((s) => s.default) || initialSubtitles[0] || null;
    setActiveSubtitle(defaultTrack);
    setReadiness((prev) => ({
      ...prev,
      selectedSubtitle: {
        enabled: !!defaultTrack,
        required: false,
        ready: true,
      },
    }));
  };

  // Handle active subtitle changes com SubtitleManager (JASSUB WASM + Nativo) e PlaybackReadiness
  useEffect(() => {
    let isCancelled = false;
    const abortController = new AbortController();

    if (activeSubtitle) {
      logger.info(`[Legenda] Ativada: ${activeSubtitle.label}`);
      localStorage.setItem('vidstack_player_subtitle', activeSubtitle.src);

      const videoEl = getVideoElement(playerRef);

      if (videoEl) {
        setIsPreparingSubtitle(true);
        subtitleManager
          .applyTrack(videoEl, activeSubtitle, audioOffsetRef.current, abortController.signal)
          .then(() => {
            if (isCancelled) return;
            failedSubtitleIdsRef.current.delete(subtitleKey(activeSubtitle));
            setIsPreparingSubtitle(false);
            setSubtitleFailurePrompt(null);
            setReadiness((prev) => ({
              ...prev,
              selectedSubtitle: { ...prev.selectedSubtitle, ready: true, failed: false },
            }));
          })
          .catch((err) => {
            if (isCancelled || err.name === 'AbortError') return;
            setIsPreparingSubtitle(false);
            logger.error(`[Legenda] Falha ao preparar "${activeSubtitle.label}":`, err);

            failedSubtitleIdsRef.current.add(subtitleKey(activeSubtitle));

            // ready = preparação concluída; failed = preparação falhou. Obrigatória ou não, falhou é ready:false + failed:true;
            // quem decide se bloqueia a reprodução é o gating (só a obrigatória bloqueia).
            setReadiness((prev) => ({
              ...prev,
              selectedSubtitle: { ...prev.selectedSubtitle, ready: false, failed: true },
            }));
            const isRequired = readinessRef.current.selectedSubtitle.required;
            if (isRequired) {
              let friendlyMessage = err.message || 'Falha ao renderizar a faixa de legenda.';
              if (err.code === 'BITMAP_NOT_SUPPORTED') {
                friendlyMessage = 'Formato de legenda baseado em imagem (PGS/VobSub) não é suportado pelo renderizador.';
              } else if (err.code === 'EXTRACTION_FAILED') {
                friendlyMessage = 'Não foi possível extrair a legenda embutida do arquivo.';
              }
              setSubtitleFailurePrompt({
                track: activeSubtitle,
                error: friendlyMessage,
                code: err.code,
              });
            }
            // Legenda opcional: o estado failed fica registrado, mas o gating não bloqueia a reprodução
          });
      }
    } else {
      logger.info('[Legenda] Desativada');
      localStorage.removeItem('vidstack_player_subtitle');
      subtitleManager.applyTrack(null as any, null);
      setIsPreparingSubtitle(false);
      setSubtitleFailurePrompt(null);
      setReadiness((prev) => ({
        ...prev,
        selectedSubtitle: { ...prev.selectedSubtitle, enabled: false, ready: true, failed: false },
      }));
    }

    return () => {
      isCancelled = true;
      abortController.abort();
    };
  }, [activeSubtitle]);

  // Ação de tentar próxima legenda disponível ao falhar a legenda obrigatória
  // Próxima legenda do ranking que ainda não falhou (sem ranking, cai na ordem das faixas)
  const findNextSubtitle = (): SubtitleTrack | null => {
    const failed = failedSubtitleIdsRef.current;
    const byId = new Map(detectedSubtitles.map((s) => [subtitleKey(s), s]));
    for (const id of rankedSubtitleIdsRef.current) {
      const track = byId.get(id);
      if (track && !failed.has(id)) return track;
    }
    return detectedSubtitles.find((s) => !failed.has(subtitleKey(s)) && !rankedSubtitleIdsRef.current.includes(subtitleKey(s))) || null;
  };

  const handleTryNextSubtitle = () => {
    if (!activeSubtitle) return;
    failedSubtitleIdsRef.current.add(subtitleKey(activeSubtitle));
    const nextTrack = findNextSubtitle();
    if (nextTrack) {
      setSubtitleFailurePrompt(null);
      setReadiness((prev) => ({
        ...prev,
        selectedSubtitle: {
          ...prev.selectedSubtitle,
          enabled: true,
          required: true,
          ready: false,
          failed: false,
        },
      }));
      setActiveSubtitle(nextTrack);
      logger.action(`[Legenda] Tentando a próxima: ${nextTrack.label}`);
    } else {
      setSubtitleFailurePrompt((prev) =>
        prev
          ? {
              ...prev,
              error: 'Nenhuma legenda compatível pôde ser carregada.',
            }
          : null
      );
    }
  };

  // Ação explícita do usuário de ignorar a legenda obrigatória e assistir sem legenda
  const handleWatchWithoutSubtitle = () => {
    setSubtitleFailurePrompt(null);
    setActiveSubtitle(null);
    setReadiness((prev) => ({
      ...prev,
      selectedSubtitle: {
        enabled: false,
        required: false,
        ready: true,
        failed: false,
      },
    }));
    logger.action('[Legenda] Assistindo sem legenda');

    const videoEl = getVideoElement(playerRef);
    if (videoEl && videoEl.paused) {
      videoEl.play().catch(() => {});
      setPaused(false);
    }
  };

  return {
    detectedSubtitles,
    setDetectedSubtitles,
    readiness,
    setReadiness,
    isPreparingSubtitle,
    activeSubtitle,
    setActiveSubtitle,
    subtitleFailurePrompt,
    findNextSubtitle,
    handleTryNextSubtitle,
    handleWatchWithoutSubtitle,
    resetSubtitleState,
    applyResolvedSubtitles,
    applyLocalSubtitles,
  };
}
