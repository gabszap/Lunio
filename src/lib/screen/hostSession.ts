import type { ScreenQuality } from '../../types/screen';
import type { ScreenApi } from './api';
import { isPickerCancel, screenErrorText, screenFailedText, screenTimeoutText } from './errors';
import type { PublisherEvents, ScreenPublisher } from './publisher';
import type { ScreenSignals } from './signals';
import { generateScreenKey } from './wire';

export type HostScreenStatus = 'idle' | 'starting' | 'live' | 'error';

export interface HostScreenEvents {
  onStatus(status: HostScreenStatus, detail?: string): void;
}

/** O servidor responde ao `screen:start` em milissegundos; passou disto, algo está errado. */
const CONFIRM_TIMEOUT_MS = 5000;

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : screenFailedText());

/**
 * Tudo o que o Host faz para transmitir: avisar a sala, pegar o token, abrir o seletor de tela, entregar a chave,
 * marcar ao vivo, girar a chave quando o servidor pede e encerrar. A ordem dos passos importa: o seletor de tela só
 * abre com um gesto recente do usuário (~5 s), então o que é rápido (aviso à sala e token) vem antes dele.
 */
export class HostScreenSession {
  private running = false;
  private stopped = false;
  /** O servidor confirmou a transmissão (então ela existe lá e precisa de um `screen:stop` ao acabar). */
  private serverStarted = false;
  private publisher: ScreenPublisher | null = null;
  private offs: Array<() => void> = [];
  private rotating: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: { signals: ScreenSignals; api: ScreenApi; createPublisher(events: PublisherEvents): Promise<ScreenPublisher> },
    private readonly events: HostScreenEvents,
  ) {}

  get hasSubscribers(): boolean {
    return this.publisher?.stats.hasSubscribers ?? false;
  }

  async start(quality: ScreenQuality): Promise<'started' | 'cancelled'> {
    if (this.running) throw new Error(screenFailedText());
    this.running = true;
    this.events.onStatus('starting');
    const { signals, api } = this.deps;
    try {
      const key = await generateScreenKey(1);
      await this.confirmStart(quality);
      if (this.stopped) return 'cancelled';

      const token = await api.fetchToken();
      if (this.stopped) return 'cancelled';
      if (!token.publish) throw new Error(screenFailedText());

      const publisher = await this.deps.createPublisher({
        onEnded: (reason, detail) => void this.onPublisherEnded(reason, detail),
        onUsage: (bytes) => signals.emitScreenUsage(bytes),
      });
      this.publisher = publisher;
      if (this.stopped) {
        await publisher.stop();
        return 'cancelled';
      }

      try {
        await publisher.start({ url: token.url, path: token.path, quality, initialKey: key });
      } catch (e) {
        if (this.stopped) return 'cancelled';
        if (isPickerCancel(e)) {
          await this.abort();
          this.events.onStatus('idle');
          return 'cancelled';
        }
        throw e;
      }
      if (this.stopped) {
        await publisher.stop();
        return 'cancelled';
      }

      signals.emitScreenKey(key);
      signals.emitScreenLive();
      this.attachLive();
      this.events.onStatus('live');
      return 'started';
    } catch (e) {
      if (!this.stopped) {
        await this.abort();
        this.events.onStatus('error', messageOf(e));
      }
      throw e;
    }
  }

  /** Idempotente. Encerra a transmissão na sala, para o publicador e solta todas as inscrições. */
  async stop(): Promise<void> {
    if (!this.running || this.stopped) return;
    this.stopped = true;
    this.release();
    if (this.serverStarted) this.deps.signals.emitScreenStop();
    await this.publisher?.stop();
    this.events.onStatus('idle');
  }

  // --- internos ---

  /** Avisa a sala e espera o servidor confirmar que a transmissão é nossa (ou recusar). */
  private confirmStart(quality: ScreenQuality): Promise<void> {
    const { signals } = this.deps;
    const me = signals.getUserId();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        offScreen();
        offError();
        fn();
      };
      const offScreen = signals.subscribeScreen((s) => {
        if (s && s.hostId === me) finish(() => ((this.serverStarted = true), resolve()));
      });
      const offError = signals.subscribeError((message, code) => {
        if (code?.startsWith('screen_')) finish(() => reject(new Error(screenErrorText(code, message))));
      });
      timer = setTimeout(
        () =>
          finish(() => {
            this.serverStarted = true; // a confirmação pode chegar depois: o `screen:stop` de limpeza cobre os dois casos
            reject(new Error(screenTimeoutText()));
          }),
        CONFIRM_TIMEOUT_MS,
      );
      signals.emitScreenStart(quality.id);
    });
  }

  private attachLive(): void {
    const { signals } = this.deps;
    const me = signals.getUserId();
    this.offs.push(signals.subscribeScreenRotate(() => this.rotate()));
    this.offs.push(
      signals.subscribeScreen((s) => {
        // Acabou (troca de Host, sala fechou…) ou passou a ser de outra pessoa: o servidor já encerrou, só paramos aqui
        if (!s || s.hostId !== me) void this.stopLocal();
      }),
    );
  }

  /** Chave nova a pedido do servidor (alguém saiu, foi expulso ou banido). Em fila, para as épocas saírem em ordem. */
  private rotate(): void {
    this.rotating = this.rotating.then(async () => {
      if (this.stopped || !this.publisher) return;
      try {
        const next = await this.publisher.rotateKey();
        if (!this.stopped) this.deps.signals.emitScreenKey(next);
      } catch {
        // publicador já parado: a transmissão está acabando
      }
    });
  }

  private async onPublisherEnded(reason: 'user' | 'error', detail?: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.release();
    if (this.serverStarted) this.deps.signals.emitScreenStop();
    this.events.onStatus(reason === 'user' ? 'idle' : 'error', detail);
  }

  private async stopLocal(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.release();
    await this.publisher?.stop();
    this.events.onStatus('idle');
  }

  /** Falha durante o `start()`: desfaz o que já tinha sido feito. */
  private async abort(): Promise<void> {
    this.stopped = true;
    this.release();
    if (this.serverStarted) this.deps.signals.emitScreenStop();
    await this.publisher?.stop();
  }

  private release(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }
}
