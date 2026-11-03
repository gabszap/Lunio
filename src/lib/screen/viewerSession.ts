import type { ScreenApi } from './api';
import { screenFailedText } from './errors';
import type { ScreenSignals } from './signals';
import type { ScreenViewer, ViewerEvents } from './viewer';
import type { ScreenKeyMaterial } from './wire';

export type ViewerScreenStatus = 'idle' | 'connecting' | 'watching' | 'paused' | 'ended' | 'error';

export interface ViewerScreenEvents {
  onStatus(status: ViewerScreenStatus, detail?: string): void;
}

/**
 * Tudo o que quem assiste faz: pegar o token de assistir, ligar o espectador às chaves da sala, assistir, voltar ao
 * vídeo (pausa: o relay para de mandar) e encerrar quando a transmissão acaba. `watch()` deve ser chamado de um
 * clique do usuário: é o gesto que libera o áudio do navegador.
 */
export class ViewerScreenSession {
  private viewer: ScreenViewer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private volume = 1;
  private disposed = false;
  private connecting = false;
  /** Cada `watch()` é uma tentativa; "Voltar ao vídeo" durante a conexão invalida a que estava em curso. */
  private attempt = 0;
  private paused = false;
  private lastStatus: ViewerScreenStatus = 'idle';
  /** Inscrições do espectador atual (chaves). */
  private offs: Array<() => void> = [];
  /** O que a sala sabe: estou assistindo? (o Host vê a lista). Só manda quando muda. */
  private announced = false;
  /**
   * Vigia do fim da transmissão. Vive mais que o espectador: quando o Host fecha a página o relay cai (erro de
   * transporte) antes do aviso do servidor chegar, e o que a pessoa precisa ler é "acabou", não um erro solto.
   */
  private endOff: (() => void) | null = null;

  constructor(
    private readonly deps: { signals: ScreenSignals; api: ScreenApi; createViewer(events: ViewerEvents): Promise<ScreenViewer> },
    private readonly events: ViewerScreenEvents,
  ) {}

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.viewer?.attach(canvas);
  }

  setVolume(v: number): void {
    this.volume = v;
    this.viewer?.setVolume(v);
  }

  async watch(): Promise<void> {
    if (this.disposed || this.connecting) return;
    if (this.viewer) {
      // Voltando de "Voltar ao vídeo": é só reinscrever (imagem em ~350 ms)
      if (this.paused) {
        this.paused = false;
        this.viewer.resume();
      }
      return;
    }

    const mine = ++this.attempt;
    this.connecting = true;
    this.emit('connecting');
    try {
      const token = await this.deps.api.fetchToken();
      if (this.disposed || mine !== this.attempt) return;
      this.watchForEnd();
      const viewer = await this.deps.createViewer({ onStatus: (s, d) => this.onViewerStatus(s, d) });
      if (this.disposed || mine !== this.attempt) {
        viewer.stop();
        return;
      }
      this.viewer = viewer;
      if (this.canvas) viewer.attach(this.canvas);
      viewer.setVolume(this.volume);

      // As chaves já guardadas chegam na hora da inscrição; todas entram antes do primeiro quadro
      const loading: Promise<void>[] = [];
      this.offs.push(this.deps.signals.subscribeScreenKey((k: ScreenKeyMaterial) => void loading.push(viewer.addKey(k).catch(() => {}))));
      await Promise.all(loading);
      await viewer.watch({ url: token.url, path: token.path });
    } catch (e) {
      if (mine !== this.attempt) return; // a pessoa já voltou ao vídeo: o erro desta tentativa não interessa
      this.discardViewer();
      if (this.lastStatus !== 'error') this.emit('error', e instanceof Error && e.message ? e.message : screenFailedText());
    } finally {
      if (mine === this.attempt) this.connecting = false;
    }
  }

  /** "Voltar ao vídeo": cancela as inscrições (0 bytes do relay); `watch()` retoma depressa. */
  returnToVideo(): void {
    if (this.connecting) {
      // Ainda conectando: desiste desta tentativa (nada fica rodando quando o token ou o motor chegarem)
      this.attempt++;
      this.connecting = false;
      this.discardViewer();
      this.unwatchEnd();
      this.emit('idle');
      return;
    }
    if (!this.viewer || this.paused) return;
    this.paused = true;
    this.viewer.pause();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.discardViewer();
    this.unwatchEnd();
    this.emit('idle');
  }

  // --- internos ---

  private onViewerStatus(status: Parameters<ViewerEvents['onStatus']>[0], detail?: string): void {
    if (!this.viewer && status !== 'error') return;
    switch (status) {
      case 'connecting':
      case 'waiting':
        this.emit('connecting');
        break;
      case 'watching':
        this.emit('watching');
        break;
      case 'paused':
        this.emit('paused');
        break;
      case 'ended':
        this.end();
        break;
      case 'error':
        this.discardViewer();
        this.emit('error', detail);
        break;
    }
  }

  /** A transmissão acabou (o servidor avisou ou o Host fechou o relay). Pode-se assistir a uma nova depois. */
  private end(): void {
    if (this.disposed) return;
    this.discardViewer();
    this.unwatchEnd();
    this.emit('ended');
  }

  private watchForEnd(): void {
    if (this.endOff) return;
    this.endOff = this.deps.signals.subscribeScreen((s) => {
      if (!s) this.end();
    });
  }

  private unwatchEnd(): void {
    this.endOff?.();
    this.endOff = null;
  }

  private discardViewer(): void {
    const viewer = this.viewer;
    this.viewer = null;
    this.paused = false;
    for (const off of this.offs) off();
    this.offs = [];
    viewer?.stop();
  }

  private emit(status: ViewerScreenStatus, detail?: string): void {
    this.lastStatus = status;
    const watching = status === 'watching';
    if (watching !== this.announced) {
      this.announced = watching;
      this.deps.signals.emitScreenWatching(watching);
    }
    this.events.onStatus(status, detail);
  }
}
