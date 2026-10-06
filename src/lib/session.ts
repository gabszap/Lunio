import { ResolvedMediaRef, SubtitleTrackRef } from '../types/media';
import { logger } from './logger';

export interface PlaybackState {
  currentTime: number;
  duration: number;
  paused: boolean;
  buffered: number;
  bufferedAhead: number;
  playbackRate: number;
  volume: number;
  muted: boolean;
}

export interface SubtitleSessionState {
  activeTrackId: string | null;
  activeCandidateId: string | null;
  label: string | null;
  format: 'ass' | 'ssa' | 'srt' | 'vtt' | null;
  required: boolean;
  ready: boolean;
}

export type RunStatus = 'starting' | 'running' | 'ready' | 'stopped' | 'failed';

export interface MediaRun {
  id: string;
  generation: number;
  start: number;
  end: number;
  status: RunStatus;
  createdAt: number;
}

/**
 * MediaRegion (Fase 3 - Inspirado no Juntos.lol):
 * Representa a janela temporal ativa deslizante (Sliding Window Ahead)
 * garantindo cobertura antecipada de ~30s em relação ao playhead.
 */
export interface MediaRegion {
  id: string;
  generation: number;
  playhead: number;
  start: number;
  end: number;
  windowAhead: number; // Padrão: 30 segundos
  bufferedAhead: number;
  isSatisfied: boolean;
  updatedAt: number;
}

export interface MediaFingerprint {
  hash: string;
  title: string;
  duration?: number;
  size?: number;
}

export interface MediaSession {
  id: string;
  generation: number;
  source: ResolvedMediaRef;
  fingerprint: MediaFingerprint;
  playback: PlaybackState;
  currentRun: MediaRun;
  activeRegion: MediaRegion;
  subtitle: SubtitleSessionState;
  createdAt: number;
  updatedAt: number;
}

type SessionListener = (session: MediaSession) => void;

/**
 * MediaSessionManager (v8 - Fase 2 & 3):
 * Entidade central para orquestração de sessões de mídia, controle de gerações (Generations),
 * janelas deslizantes (Regions de 30s) e tratamento cirúrgico de Cold Seeks com cancelamento ativo.
 */
class MediaSessionManager {
  private currentSession: MediaSession | null = null;
  private currentGeneration = 0;
  private abortController: AbortController | null = null;
  private listeners: Set<SessionListener> = new Set();
  private readonly DEFAULT_WINDOW_AHEAD = 30; // 30 segundos de antecipação

  /**
   * Obtém a sessão ativa
   */
  public getSession(): MediaSession | null {
    return this.currentSession;
  }

  /**
   * Obtém o ID da sessão ativa
   */
  public getSessionId(): string | null {
    return this.currentSession ? this.currentSession.id : null;
  }

  /**
   * Obtém o MediaRun ativo
   */
  public getCurrentRun(): MediaRun | null {
    return this.currentSession ? this.currentSession.currentRun : null;
  }

  /**
   * Obtém a MediaRegion ativa
   */
  public getActiveRegion(): MediaRegion | null {
    return this.currentSession ? this.currentSession.activeRegion : null;
  }

  /**
   * Obtém a geração atual
   */
  public getGeneration(): number {
    return this.currentGeneration;
  }

  /**
   * Obtém o AbortSignal da geração atual para cancelamento em cascata
   */
  public getAbortSignal(): AbortSignal | null {
    return this.abortController ? this.abortController.signal : null;
  }

  /**
   * Verifica se uma determinada geração ainda é a ativa
   */
  public isCurrentGeneration(generation: number): boolean {
    return this.currentGeneration === generation;
  }

  /**
   * Inscreve um listener para receber notificações de mudanças na sessão
   */
  public subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    if (this.currentSession) {
      listener(this.currentSession);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    if (this.currentSession) {
      this.currentSession.updatedAt = Date.now();
      for (const listener of this.listeners) {
        try {
          listener(this.currentSession);
        } catch (err) {
          logger.warn('[Player] Erro ao notificar a sessão de mídia:', err);
        }
      }
    }
  }

  /**
   * Inicia uma nova sessão de mídia para a referência resolvida
   */
  public createSession(source: ResolvedMediaRef, initialTime = 0): MediaSession {
    // Cancela qualquer operação pendente da sessão anterior
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    this.currentGeneration += 1;
    const gen = this.currentGeneration;
    const sessionId = `session_${Date.now()}_g${gen}`;
    const runId = `run_${Date.now()}_g${gen}_0`;
    const regionId = `region_${Date.now()}_g${gen}`;

    const fingerprint: MediaFingerprint = {
      hash: source.infoHash || source.videoHash || this.generateFallbackHash(source.mediaUrl),
      title: source.title,
      duration: source.duration,
      size: source.size,
    };

    const windowAhead = this.DEFAULT_WINDOW_AHEAD;
    const regionEnd = source.duration ? Math.min(source.duration, initialTime + windowAhead) : initialTime + windowAhead;

    const initialRegion: MediaRegion = {
      id: regionId,
      generation: gen,
      playhead: initialTime,
      start: initialTime,
      end: regionEnd,
      windowAhead,
      bufferedAhead: 0,
      isSatisfied: false,
      updatedAt: Date.now(),
    };

    const initialRun: MediaRun = {
      id: runId,
      generation: gen,
      start: initialTime,
      end: regionEnd,
      status: 'starting',
      createdAt: Date.now(),
    };

    const initialPlayback: PlaybackState = {
      currentTime: initialTime,
      duration: source.duration || 0,
      paused: true,
      buffered: 0,
      bufferedAhead: 0,
      playbackRate: 1.0,
      volume: 1.0,
      muted: false,
    };

    const initialSubtitle: SubtitleSessionState = {
      activeTrackId: source.subtitleTracks[0]?.id || null,
      activeCandidateId: null,
      label: source.subtitleTracks[0]?.label || null,
      format: (source.subtitleTracks[0]?.format as any) || null,
      required: false,
      ready: false,
    };

    this.currentSession = {
      id: sessionId,
      generation: gen,
      source,
      fingerprint,
      playback: initialPlayback,
      currentRun: initialRun,
      activeRegion: initialRegion,
      subtitle: initialSubtitle,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.notify();
    return this.currentSession;
  }

  /**
   * Atualiza a posição atual de reprodução (Playhead) e a janela física de reprodução (Fase 3 - Regions)
   * Mantém o início da região (start) estável enquanto o playhead avança dentro dela,
   * expandindo a borda final (end) apenas quando o playhead se aproximar do fim da janela.
   */
  public updatePlayhead(currentTime: number, bufferedAhead = 0): void {
    if (!this.currentSession) return;

    const session = this.currentSession;
    const duration = session.source.duration || session.playback.duration || 0;
    const windowAhead = session.activeRegion.windowAhead || this.DEFAULT_WINDOW_AHEAD;
    const currentRegion = session.activeRegion;

    let newStart = currentRegion.start;
    let newEnd = currentRegion.end;

    // Se o playhead saltou para trás da região ou avançou próximo do final, expande a fronteira
    if (currentTime < newStart) {
      newStart = Math.max(0, currentTime);
      newEnd = duration > 0 ? Math.min(duration, currentTime + windowAhead) : currentTime + windowAhead;
    } else if (currentTime > newEnd - 5) {
      newEnd = duration > 0 ? Math.min(duration, Math.max(newEnd, currentTime + windowAhead)) : Math.max(newEnd, currentTime + windowAhead);
    }

    const isSatisfied = bufferedAhead >= Math.min(10, windowAhead * 0.33);

    session.activeRegion = {
      ...currentRegion,
      playhead: currentTime,
      start: newStart,
      end: newEnd,
      bufferedAhead,
      isSatisfied,
      updatedAt: Date.now(),
    };

    session.playback.currentTime = currentTime;
    session.playback.bufferedAhead = bufferedAhead;

    // Conecta status de prontidão do run físico se estiver em execução e buffer satisfeito
    if (isSatisfied && session.currentRun.status === 'running') {
      session.currentRun.status = 'ready';
    }

    this.notify();
  }

  /**
   * Avalia e executa uma requisição de Seek distinguindo Warm Seek vs Cold Seek (Fase 3)
   * - Warm Seek: Posição está contida na região atual ou no buffer da RAM -> Seek instantâneo sem cancelamento
   * - Cold Seek: Posição está distante fora da região -> Cancela run anterior, avança geração e cria nova região de 30s
   */
  public evaluateSeek(targetTime: number, isAlreadyBuffered: boolean): { isColdSeek: boolean; generation: number } {
    if (!this.currentSession) {
      return { isColdSeek: false, generation: this.currentGeneration };
    }

    const session = this.currentSession;
    const region = session.activeRegion;

    // Se já está na memória ou dentro da janela de reprodução atual, é um Warm Seek
    const isWithinActiveWindow = targetTime >= region.start - 1.0 && targetTime <= region.end + 2.0;
    const isWarmSeek = isAlreadyBuffered || isWithinActiveWindow;

    if (isWarmSeek) {
      // Warm Seek: Mantém a geração ativa e apenas ajusta o playhead
      this.updatePlayhead(targetTime, Math.max(0, region.end - targetTime));
      return { isColdSeek: false, generation: this.currentGeneration };
    }

    // Cold Seek: Salto distante para fora da região
    // 1. Cancela operações da geração anterior
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    // 2. Incrementa atomicamente a geração
    this.currentGeneration += 1;
    const newGen = this.currentGeneration;
    session.generation = newGen;

    // 3. Estabelece a nova região deslizante de 30s a partir do targetTime
    const duration = session.source.duration || session.playback.duration || 0;
    const windowAhead = this.DEFAULT_WINDOW_AHEAD;
    const newEnd = duration > 0 ? Math.min(duration, targetTime + windowAhead) : targetTime + windowAhead;

    session.activeRegion = {
      id: `region_${Date.now()}_g${newGen}`,
      generation: newGen,
      playhead: targetTime,
      start: targetTime,
      end: newEnd,
      windowAhead,
      bufferedAhead: 0,
      isSatisfied: false,
      updatedAt: Date.now(),
    };

    // 4. Inicia um novo MediaRun para a nova região
    session.currentRun = {
      id: `run_${Date.now()}_g${newGen}`,
      generation: newGen,
      start: targetTime,
      end: newEnd,
      status: 'starting',
      createdAt: Date.now(),
    };

    session.playback.currentTime = targetTime;

    this.notify();
    return { isColdSeek: true, generation: newGen };
  }

  /**
   * Atualiza o estado de playback na sessão ativa
   */
  public updatePlayback(partial: Partial<PlaybackState>): void {
    if (!this.currentSession) return;
    this.currentSession.playback = {
      ...this.currentSession.playback,
      ...partial,
    };
    this.notify();
  }

  /**
   * Atualiza o estado de legendas na sessão ativa
   */
  public updateSubtitle(partial: Partial<SubtitleSessionState>): void {
    if (!this.currentSession) return;
    this.currentSession.subtitle = {
      ...this.currentSession.subtitle,
      ...partial,
    };
    this.notify();
  }

  /**
   * Atualiza o status do run atual
   */
  public updateRunStatus(status: RunStatus): void {
    if (!this.currentSession) return;
    this.currentSession.currentRun.status = status;
    this.notify();
  }

  /**
   * Encerra a sessão ativa e cancela qualquer requisição em aberto
   */
  public closeSession(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.currentSession) {
      this.currentSession.currentRun.status = 'stopped';
      this.currentSession = null;
    }
  }

  private generateFallbackHash(url: string): string {
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      hash = (hash << 5) - hash + url.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }
}

export const sessionManager = new MediaSessionManager();
