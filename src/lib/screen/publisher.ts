import type { ScreenQuality } from '../../types/screen';
import { isPickerCancel } from './errors';
import { FrameMuxer } from './muxer';
import { AUDIO_ENCODER_CONFIG, keyframeInterval, videoEncoderConfig } from './quality';
import { CaptureClock, FrameDecimator } from './timing';
import type { PublishHandle, ScreenTransport } from './transport';
import { FrameSealer, generateScreenKey, type ScreenKeyMaterial } from './wire';

/** Depois de gerar uma chave nova, os espectadores precisam recebê-la pela sala antes dos primeiros quadros dela. */
export const KEY_SWITCH_DELAY_MS = 400;

/** Acima disto o codificador está atrasado: o quadro é descartado em vez de aumentar a latência. */
const MAX_ENCODE_QUEUE = 4;
const STAMP_MAP_LIMIT = 120;

// --- Contrato com o navegador (a implementação real está em publisherBrowser.ts; os testes usam falsos) ---

export interface VideoFrameLike {
  /** Microssegundos, no relógio da captura. */
  timestamp: number;
  displayWidth: number;
  displayHeight: number;
  close(): void;
}

export interface AudioDataLike {
  timestamp: number;
  duration: number;
  close(): void;
}

export interface FrameReader<T> {
  read(): Promise<{ done: boolean; value?: T }>;
}

export interface Capture {
  video: FrameReader<VideoFrameLike>;
  audio: FrameReader<AudioDataLike> | null;
  /** O navegador (botão "parar de compartilhar") encerrou a captura. */
  onEnded(cb: () => void): void;
  /** Imagem da captura para o Host se ver (a prévia); a mesma faixa que vai ao codificador. */
  preview?: MediaStream;
  /** Pede à própria captura o tamanho e o fps da nova qualidade (sem abrir o seletor de novo). Pode não ser suportado. */
  applyQuality?(q: ScreenQuality): Promise<void>;
  stop(): void;
}

export interface VideoEncoderLike {
  configure(cfg: VideoEncoderConfig): Promise<void> | void;
  encode(frame: VideoFrameLike, opts: { keyFrame: boolean }): void;
  readonly encodeQueueSize: number;
  close(): void;
}

export interface AudioEncoderLike {
  configure(cfg: AudioEncoderConfig): Promise<void> | void;
  encode(data: AudioDataLike): void;
  close(): void;
}

export interface PublisherBrowser {
  capture(q: ScreenQuality): Promise<Capture>;
  createVideoEncoder(h: {
    output(c: { key: boolean; data: Uint8Array; timestampUs: number }): void;
    error(e: unknown): void;
  }): VideoEncoderLike;
  createAudioEncoder(h: { output(c: { data: Uint8Array; timestampUs: number }): void; error(e: unknown): void }): AudioEncoderLike;
}

export interface PublisherEvents {
  /** A transmissão acabou sem o `stop()` de quem chamou: o usuário parou a captura ou houve erro irrecuperável. */
  onEnded(reason: 'user' | 'error', detail?: string): void;
  /** Total de bytes publicados até agora, a cada ~3 s (a sala repassa ao servidor como `screen:usage`). */
  onUsage(bytesOut: number): void;
}

export interface PublisherStats {
  read: number;
  skipped: number;
  queueDrops: number;
  encodedFrames: number;
  /** Quadros codificados no último segundo. */
  fps: number;
  width: number;
  height: number;
  bytesOut: number;
  dropped: number;
  hasSubscribers: boolean;
}

interface StartOptions {
  url: string;
  path: string;
  quality: ScreenQuality;
  initialKey: ScreenKeyMaterial;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Captura a tela, codifica (H.264 + Opus), cifra e publica. A lógica fica aqui; as APIs do navegador entram por
 * `PublisherBrowser`. Nunca registra chave, URL do relay nem o caminho da transmissão.
 */
export class ScreenPublisher {
  private state: 'idle' | 'running' | 'stopped' = 'idle';
  private readonly sealer = new FrameSealer();
  private readonly vclock = new CaptureClock();
  private readonly aclock = new CaptureClock();
  private decimator: FrameDecimator | null = null;
  private muxer: FrameMuxer | null = null;
  private handle: PublishHandle | null = null;
  private capture: Capture | null = null;
  private venc: VideoEncoderLike | null = null;
  private aenc: AudioEncoderLike | null = null;
  private quality: ScreenQuality | null = null;
  private readonly stamps = new Map<number, number>();
  private keyTimers = new Set<ReturnType<typeof setTimeout>>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private latestEpoch = 0;
  /** Cada captura tem a sua geração: ao trocar de tela, os leitores da captura antiga terminam sem mexer em nada. */
  private captureGen = 0;
  /** A qualidade mudou: o próximo quadro reconfigura o codificador (bitrate, nível) e recomeça num quadro-chave. */
  private forceConfigure = false;
  private counters = { read: 0, skipped: 0, queueDrops: 0, encodedFrames: 0, fps: 0, width: 0, height: 0 };

  constructor(
    private readonly deps: { transport: ScreenTransport; browser: PublisherBrowser; now?: () => number },
    private readonly events: PublisherEvents,
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** O que está sendo capturado agora, para o Host se ver. `null` sem captura (ou sem suporte do navegador). */
  get previewStream(): MediaStream | null {
    return this.capture?.preview ?? null;
  }

  get qualityId(): ScreenQuality['id'] | null {
    return this.quality?.id ?? null;
  }

  get stats(): PublisherStats {
    return {
      ...this.counters,
      bytesOut: this.muxer?.bytesOut ?? 0,
      dropped: this.muxer?.dropped ?? 0,
      hasSubscribers: this.handle?.hasSubscribers() ?? false,
    };
  }

  /**
   * `initialKey` tem de ser uma chave NOVA a cada `start()`: quem recarrega a página gera outra, nunca reaproveita a
   * da transmissão anterior (o IV usa um prefixo aleatório por instância, mas chave nova é a regra).
   */
  async start(opts: StartOptions): Promise<void> {
    if (this.state !== 'idle') throw new Error('A transmissão já foi iniciada.');
    this.state = 'running';
    this.quality = opts.quality;
    this.decimator = new FrameDecimator(opts.quality.fps);
    this.latestEpoch = opts.initialKey.epoch;
    try {
      await this.sealer.setKey(opts.initialKey);
      this.capture = await this.deps.browser.capture(opts.quality);
      this.assertRunning(); // o seletor de tela pode ter ficado aberto enquanto a sala mudava
      this.handle = await this.deps.transport.publish(opts.url, opts.path);
      this.assertRunning();
      const muxer = (this.muxer = new FrameMuxer(this.sealer, { video: this.handle.video, audio: this.handle.audio }));

      this.venc = this.deps.browser.createVideoEncoder({
        output: (c) => {
          const stamp = this.stamps.get(c.timestampUs) ?? this.now();
          this.stamps.delete(c.timestampUs);
          muxer.pushVideo({ key: c.key, data: c.data, timestampUs: c.timestampUs }, stamp);
        },
        error: (e) => void this.finish('error', describe(e)),
      });

      if (this.capture.audio) await this.ensureAudioEncoder();
      this.attachCapture(this.capture);

      let ticks = 0;
      let lastEncoded = 0;
      this.ticker = setInterval(() => {
        this.counters.fps = this.counters.encodedFrames - lastEncoded;
        lastEncoded = this.counters.encodedFrames;
        if (++ticks % 3 === 0) this.events.onUsage(muxer.bytesOut);
      }, 1000);
    } catch (e) {
      await this.teardown();
      throw e;
    }
  }

  /**
   * Muda a qualidade com a transmissão no ar: a captura recebe o novo tamanho/fps (se o navegador deixar), o fps de
   * saída muda e o codificador é reconfigurado no próximo quadro (bitrate novo, quadro-chave).
   */
  async setQuality(q: ScreenQuality): Promise<void> {
    if (this.state !== 'running') throw new Error('A transmissão não está ativa.');
    this.quality = q;
    this.decimator = new FrameDecimator(q.fps);
    this.forceConfigure = true;
    try {
      await this.capture?.applyQuality?.(q);
    } catch {
      // O navegador não ajustou a captura: o codificador ainda reduz para o tamanho e o bitrate novos
    }
  }

  /** Cria o codificador de áudio quando a captura traz áudio (na troca de tela, a nova pode ter áudio e a antiga não). */
  private async ensureAudioEncoder(): Promise<void> {
    const muxer = this.muxer;
    if (this.aenc || !muxer) return;
    const aenc = this.deps.browser.createAudioEncoder({
      output: (c) => muxer.pushAudio(c, this.aclock.peek(c.timestampUs / 1000) ?? this.now() - 20),
      error: (e) => void this.finish('error', describe(e)),
    });
    this.aenc = aenc;
    await aenc.configure(AUDIO_ENCODER_CONFIG);
    this.assertRunning();
  }

  /** Liga uma captura ao codificador: ela vira a captura atual e a anterior (se houver) fica para trás. */
  private attachCapture(capture: Capture): void {
    const gen = ++this.captureGen;
    this.capture = capture;
    capture.onEnded(() => {
      if (gen === this.captureGen) void this.finish('user');
    });
    void this.runVideo(capture.video, gen);
    if (capture.audio) void this.runAudio(capture.audio, gen);
  }

  /**
   * "Trocar a tela": pede outra captura sem parar a transmissão (mesma sala, mesma chave, mesmo relay). Cancelar o
   * seletor mantém a captura atual. O gesto do usuário (clique) precisa estar fresco, como no `start`.
   */
  async replaceSource(): Promise<'switched' | 'cancelled'> {
    if (this.state !== 'running' || !this.quality) throw new Error('A transmissão não está ativa.');
    let next: Capture;
    try {
      next = await this.deps.browser.capture(this.quality);
    } catch (e) {
      if (isPickerCancel(e)) return 'cancelled';
      throw e;
    }
    if (this.state !== 'running') {
      next.stop();
      return 'cancelled';
    }
    try {
      if (next.audio) await this.ensureAudioEncoder();
    } catch (e) {
      next.stop();
      throw e;
    }
    const previous = this.capture;
    // Outra captura, outro relógio: recomeça carimbos, decimação e o mapa de carimbos pendentes
    this.vclock.reset();
    this.aclock.reset();
    this.decimator?.reset();
    this.stamps.clear();
    this.attachCapture(next);
    try {
      previous?.stop();
    } catch {}
    return 'switched';
  }

  /** `stop()` (ou um erro) chegou durante um `await` do `start()`: o `catch` do `start` solta o que já foi aberto. */
  private assertRunning(): void {
    if (this.state !== 'running') throw new Error('A transmissão foi encerrada durante o início.');
  }

  /**
   * Gera a próxima chave. Quem chama a entrega à sala já; o publicador só passa a usá-la depois de
   * `KEY_SWITCH_DELAY_MS`, para os espectadores a terem antes dos primeiros quadros cifrados com ela.
   */
  async rotateKey(): Promise<ScreenKeyMaterial> {
    if (this.state !== 'running') throw new Error('A transmissão não está ativa.');
    const next = await generateScreenKey(this.latestEpoch + 1);
    this.latestEpoch = next.epoch;
    const timer = setTimeout(() => {
      this.keyTimers.delete(timer);
      if (this.state === 'running') void this.sealer.setKey(next);
    }, KEY_SWITCH_DELAY_MS);
    this.keyTimers.add(timer);
    return next;
  }

  /** Resolve quando tudo o que foi codificado até agora já foi escrito no relay. */
  async flush(): Promise<void> {
    await this.muxer?.flush();
  }

  /** Idempotente: para a captura, os codificadores e os timers e fecha o relay. Não dispara `onEnded`. */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    await this.teardown();
  }

  private async finish(reason: 'user' | 'error', detail?: string): Promise<void> {
    if (this.state !== 'running') return;
    await this.teardown();
    this.events.onEnded(reason, detail);
  }

  private async teardown(): Promise<void> {
    this.state = 'stopped';
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    for (const t of this.keyTimers) clearTimeout(t);
    this.keyTimers.clear();
    try {
      this.capture?.stop();
    } catch {}
    this.capture = null;
    for (const enc of [this.venc, this.aenc]) {
      try {
        enc?.close();
      } catch {}
    }
    try {
      await this.muxer?.flush();
    } catch {}
    try {
      this.handle?.close();
    } catch {}
    this.stamps.clear();
  }

  private async runVideo(reader: FrameReader<VideoFrameLike>, gen: number): Promise<void> {
    let sinceKey = 0;
    let width = 0;
    let height = 0;
    try {
      for (;;) {
        const r = await reader.read();
        const frame = r.value;
        if (r.done || !frame) break;
        try {
          if (this.state !== 'running' || gen !== this.captureGen || !this.venc || !this.quality || !this.decimator) return;
          this.counters.read++;
          if (frame.displayWidth !== width || frame.displayHeight !== height || this.forceConfigure) {
            this.forceConfigure = false;
            width = frame.displayWidth;
            height = frame.displayHeight;
            await this.venc.configure(videoEncoderConfig(this.quality, width, height));
            this.counters.width = width;
            this.counters.height = height;
            sinceKey = 0; // a mudança de tamanho recomeça num quadro-chave
          }
          const captureMs = frame.timestamp / 1000;
          if (!this.decimator.shouldEncode(captureMs)) {
            this.counters.skipped++;
            continue;
          }
          if (this.venc.encodeQueueSize > MAX_ENCODE_QUEUE) {
            this.counters.queueDrops++;
            continue;
          }
          this.stamps.set(frame.timestamp, this.vclock.stamp(captureMs, this.now()));
          if (this.stamps.size > STAMP_MAP_LIMIT) this.stamps.delete(this.stamps.keys().next().value as number);
          this.venc.encode(frame, { keyFrame: sinceKey++ % keyframeInterval(this.quality) === 0 });
          this.counters.encodedFrames++;
        } finally {
          frame.close();
        }
      }
    } catch (e) {
      if (gen === this.captureGen) void this.finish('error', describe(e));
      return;
    }
    // O fluxo da captura acabou sem erro: é a captura que terminou (a que foi trocada por outra não conta)
    if (gen === this.captureGen) void this.finish('user');
  }

  private async runAudio(reader: FrameReader<AudioDataLike>, gen: number): Promise<void> {
    try {
      for (;;) {
        const r = await reader.read();
        const data = r.value;
        if (r.done || !data) return;
        try {
          if (this.state !== 'running' || gen !== this.captureGen || !this.aenc) return;
          // O offset é medido no fim do bloco; o carimbo de cada bloco codificado usa o início dele
          this.aclock.stamp((data.timestamp + data.duration) / 1000, this.now());
          this.aenc.encode(data);
        } finally {
          data.close();
        }
      }
    } catch (e) {
      if (gen === this.captureGen) void this.finish('error', describe(e));
    }
  }
}
