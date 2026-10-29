import { codecFromAnnexB } from './h264';
import { AudioPlayout, VideoOnlyClock, VideoPlayout } from './playout';
import { AUDIO_ENCODER_CONFIG } from './quality';
import type { ScreenTransport, TrackSource, WatchHandle } from './transport';
import { FrameOpener, type OpenedFrame, type ScreenKeyMaterial } from './wire';

/** Só o valor inicial do decodificador: o real vem do SPS do primeiro quadro-chave. */
const FALLBACK_VIDEO_CODEC = 'avc1.640028';
const MAX_DRAW_WIDTH = 960;

/**
 * Lê uma faixa, abre cada quadro (decifra) e o entrega na ordem. Nunca lança para fora: quadro curto, adulterado ou
 * sem chave é ignorado (e contado pelo `FrameOpener`); falha da conexão vira o resultado `'error'`.
 */
export class FrameIntake {
  constructor(private readonly opener: FrameOpener) {}

  /** `onDrop`: um quadro não abriu (sem chave ainda, adulterado, curto). O vídeo usa para esperar o próximo quadro-chave. */
  async run(source: TrackSource, onFrame: (o: OpenedFrame) => void, isCurrent: () => boolean, onDrop?: () => void): Promise<'ended' | 'error'> {
    try {
      for await (const payload of source.frames()) {
        if (!isCurrent()) return 'ended';
        const opened = await this.opener.open(payload);
        if (!opened) {
          onDrop?.();
          continue;
        }
        if (!isCurrent()) continue;
        try {
          onFrame(opened);
        } catch {
          // O decodificador recusou este quadro: o próximo quadro-chave recomeça
        }
      }
      return 'ended';
    } catch {
      return 'error';
    }
  }
}

export interface ViewerEvents {
  onStatus(status: 'connecting' | 'waiting' | 'watching' | 'paused' | 'ended' | 'error', detail?: string): void;
}

export interface ViewerStats {
  /** Quadros desenhados no último segundo. */
  fps: number;
  decoded: number;
  /** Descartados por atraso (> 250 ms) ou por fila cheia. */
  droppedVideo: number;
  /** Pulos até o último quadro-chave (atraso > 1,5 s). */
  skippedVideo: number;
  /** Idade média do quadro ao chegar (só vale se os relógios do Host e daqui concordam, como num teste local). */
  netVideoMs: number;
  netAudioMs: number;
  bufferMs: number;
  targetMs: number;
  underruns: number;
  ok: number;
  noKey: number;
  badTag: number;
  malformed: number;
}

const ema = (prev: number, v: number) => (prev ? Math.round(prev * 0.9 + v * 0.1) : Math.round(v));

interface Decoded {
  t: number;
  frame: VideoFrame;
}

/**
 * Assiste à transmissão: recebe pelo transporte, decifra, decodifica e mostra no canvas com o áudio como relógio
 * mestre. O agendamento mora em `playout.ts`; aqui só se liga às APIs do navegador.
 */
export class ScreenViewer {
  private readonly opener = new FrameOpener();
  private readonly intake = new FrameIntake(this.opener);
  private readonly audioPlayout = new AudioPlayout();
  private readonly videoPlayout = new VideoPlayout<Decoded>();
  /** Relógio de reserva para transmissão sem áudio (o áudio, quando existe, é o relógio mestre). */
  private readonly videoClock = new VideoOnlyClock();
  private limiter: DynamicsCompressorNode | null = null;

  private state: 'idle' | 'running' | 'stopped' = 'idle';
  private paused = false;
  private gen = 0;
  private pumpsDone = 0;
  private pumpFailed = false;

  private canvas: HTMLCanvasElement | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private ac: AudioContext | null = null;
  private gain: GainNode | null = null;
  private handle: WatchHandle | null = null;
  private sources: TrackSource[] = [];
  private abort: AbortController | null = null;
  private vdec: VideoDecoder | null = null;
  private adec: AudioDecoder | null = null;
  private codec: string | null = null;
  private raf = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private volume = 1;
  private sinkId = '';
  private lastUnderruns = 0;
  private drawn = 0;
  private counters = { fps: 0, decoded: 0, droppedVideo: 0, skippedVideo: 0, netVideoMs: 0, netAudioMs: 0 };

  constructor(
    private readonly deps: { transport: ScreenTransport; audioContext?: AudioContext },
    private readonly events: ViewerEvents,
  ) {}

  get stats(): ViewerStats {
    return {
      ...this.counters,
      bufferMs: this.audioPlayout.bufferedMs,
      targetMs: Math.round(this.audioPlayout.targetS * 1000),
      underruns: this.audioPlayout.underruns,
      ...this.opener.counts,
    };
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
  }

  /** As chaves vêm da sala e podem chegar antes ou depois de `watch()`. */
  async addKey(m: ScreenKeyMaterial): Promise<void> {
    await this.opener.addKey(m);
  }

  async watch(opts: { url: string; path: string }): Promise<void> {
    if (this.state !== 'idle') throw new Error('O espectador já foi iniciado.');
    this.state = 'running';
    this.events.onStatus('connecting');
    this.abort = new AbortController();
    try {
      // Criado aqui porque o "Assistir" do usuário é o gesto que libera o áudio
      const ac = (this.ac = this.deps.audioContext ?? new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }));
      await ac.resume();
      if (this.state !== 'running') return; // stop() chegou enquanto o áudio era liberado
      this.buildAudioGraph(ac);
      this.vdec = this.makeVideoDecoder();
      this.adec = this.makeAudioDecoder();

      this.events.onStatus('waiting');
      this.handle = await this.deps.transport.watch(opts.url, opts.path, this.abort.signal);
      if (this.state !== 'running') {
        this.handle.close();
        return;
      }
      this.startLoops();
      this.startSubs();
      this.events.onStatus('watching');
    } catch (e) {
      if (this.state !== 'running') return;
      this.teardown();
      this.events.onStatus('error', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /** Cancela as inscrições (o relay para de mandar: 0 bytes) e limpa o que estava em curso. */
  pause(): void {
    if (this.state !== 'running' || this.paused) return;
    this.paused = true;
    this.gen++;
    this.closeSources();
    const { decoded } = this.videoPlayout.reset();
    for (const d of decoded) d.frame.close();
    this.audioPlayout.reset();
    this.videoClock.reset();
    this.silenceScheduledAudio();
    try {
      this.adec?.reset();
      this.adec?.configure(this.audioConfig());
    } catch {}
    try {
      this.vdec?.reset();
    } catch {}
    this.codec = null;
    this.events.onStatus('paused');
  }

  /** Reinscreve; a imagem volta no próximo quadro-chave e o som no próximo bloco. */
  resume(): void {
    if (this.state !== 'running' || !this.paused) return;
    this.paused = false;
    this.startSubs();
    this.events.onStatus('watching');
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, v);
    if (this.gain) this.gain.gain.value = this.volume;
  }

  async setSinkId(id: string): Promise<void> {
    this.sinkId = id;
    const ac = this.ac as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (ac?.setSinkId) await ac.setSinkId(id);
  }

  stop(): void {
    if (this.state === 'stopped') return;
    this.teardown();
  }

  // --- internos ---

  private audioConfig(): AudioDecoderConfig {
    return { codec: AUDIO_ENCODER_CONFIG.codec, sampleRate: AUDIO_ENCODER_CONFIG.sampleRate, numberOfChannels: AUDIO_ENCODER_CONFIG.numberOfChannels };
  }

  private buildAudioGraph(ac: AudioContext): void {
    this.gain = ac.createGain();
    this.gain.gain.value = this.volume;
    // Limitador: o áudio do sistema do Host pode vir alto
    const limiter = new DynamicsCompressorNode(ac, { threshold: -1, knee: 0, ratio: 20, attack: 0.003, release: 0.25 });
    this.gain.connect(limiter);
    limiter.connect(ac.destination);
    this.limiter = limiter;
    if (this.sinkId) void this.setSinkId(this.sinkId).catch(() => {});
  }

  /** Os blocos já agendados (até o alvo do buffer, 0,9 s no pior caso) iriam tocar por cima do som novo na retomada. */
  private silenceScheduledAudio(): void {
    const ac = this.ac;
    if (!ac || !this.gain || !this.limiter) return;
    this.gain.disconnect();
    this.gain = ac.createGain();
    this.gain.gain.value = this.volume;
    this.gain.connect(this.limiter);
  }

  private makeVideoDecoder(): VideoDecoder {
    return new VideoDecoder({
      output: (frame) => {
        this.counters.decoded++;
        for (const d of this.videoPlayout.addDecoded({ t: frame.timestamp / 1000, frame })) {
          d.frame.close();
          this.counters.droppedVideo++;
        }
      },
      error: () => {
        // Decodificador caiu: recria e recomeça no próximo quadro-chave
        if (this.state !== 'running') return;
        this.vdec = this.makeVideoDecoder();
        this.codec = null;
        this.videoPlayout.markNeedKey();
      },
    });
  }

  private makeAudioDecoder(): AudioDecoder {
    const dec = new AudioDecoder({
      output: (data) => {
        const ac = this.ac;
        const gain = this.gain;
        const n = data.numberOfFrames;
        if (!ac || !gain || this.state !== 'running') return data.close();
        const buffer = ac.createBuffer(data.numberOfChannels, n, data.sampleRate);
        for (let c = 0; c < data.numberOfChannels; c++) {
          const plane = new Float32Array(n);
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          buffer.copyToChannel(plane, c);
        }
        const stamp = this.audioPlayout.shiftStamp(data.timestamp / 1000);
        data.close();
        const { startAt } = this.audioPlayout.schedule(ac.currentTime, buffer.duration, stamp);
        const source = ac.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        source.start(startAt);
      },
      error: () => {
        if (this.state !== 'running') return;
        this.adec = this.makeAudioDecoder();
        this.adec.configure(this.audioConfig());
      },
    });
    dec.configure(this.audioConfig());
    return dec;
  }

  private startSubs(): void {
    const handle = this.handle;
    if (!handle) return;
    const mine = ++this.gen;
    this.pumpsDone = 0;
    this.pumpFailed = false;
    const current = () => mine === this.gen && this.state === 'running';
    const audio = handle.track('audio');
    const video = handle.track('video');
    this.sources = [audio, video];
    const done = (r: 'ended' | 'error') => {
      if (!current()) return;
      if (r === 'error') this.pumpFailed = true;
      if (++this.pumpsDone < 2) return;
      this.events.onStatus(this.pumpFailed ? 'error' : 'ended', this.pumpFailed ? 'A conexão com a transmissão caiu.' : undefined);
    };
    void this.intake.run(audio, (o) => this.onAudio(o), current).then(done);
    // Vídeo que não abre (chave atrasada) deixa referências faltando: espera o próximo quadro-chave em vez de mostrar lixo
    void this.intake.run(video, (o) => this.onVideo(o), current, () => this.videoPlayout.markNeedKey()).then(done);
  }

  private closeSources(): void {
    for (const s of this.sources) {
      try {
        s.close();
      } catch {}
    }
    this.sources = [];
  }

  private onAudio(o: OpenedFrame): void {
    this.counters.netAudioMs = ema(this.counters.netAudioMs, Date.now() - o.stamp);
    this.adec?.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(o.stamp * 1000), data: o.data }));
    // Só depois de aceito: um decode() que lança não pode deixar um carimbo sobrando na fila (o áudio defasaria)
    this.audioPlayout.pushStamp(o.stamp);
  }

  private onVideo(o: OpenedFrame): void {
    this.videoClock.note(o.stamp, performance.now());
    this.counters.netVideoMs = ema(this.counters.netVideoMs, Date.now() - o.stamp);
    this.videoPlayout.enqueue({ t: o.stamp, key: o.key, data: o.data });
  }

  private startLoops(): void {
    const loop = () => {
      if (this.state !== 'running') return;
      this.raf = requestAnimationFrame(loop);
      this.tick();
    };
    this.raf = requestAnimationFrame(loop);
    this.timer = setInterval(() => {
      this.counters.fps = this.drawn;
      this.drawn = 0;
      // Um segundo sem falhas de áudio: o buffer pode encolher de volta
      if (this.audioPlayout.underruns === this.lastUnderruns) this.audioPlayout.relax();
      this.lastUnderruns = this.audioPlayout.underruns;
    }, 1000);
  }

  private tick(): void {
    const ac = this.ac;
    const vdec = this.vdec;
    if (!ac || !vdec) return;
    // Com áudio ele é o relógio; sem áudio (transmissão válida) o vídeo anda pelo relógio de parede
    const S = this.audioPlayout.mediaTimeMs(ac.currentTime, ac.outputLatency || 0) ?? this.videoClock.mediaTimeMs(performance.now());
    if (S === null) return;

    const { chunks, skipped } = this.videoPlayout.takeForDecode(S, vdec.decodeQueueSize);
    this.counters.skippedVideo += skipped;
    for (const c of chunks) {
      try {
        if (c.key) this.ensureVideoDecoder(c.data);
        this.vdec!.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: Math.round(c.t * 1000), data: c.data }));
      } catch {
        this.videoPlayout.markNeedKey();
      }
    }

    const { frame, dropped } = this.videoPlayout.pick(S);
    for (const d of dropped) {
      d.frame.close();
      this.counters.droppedVideo++;
    }
    if (frame) {
      this.draw(frame.frame);
      frame.frame.close();
      this.drawn++;
    }
  }

  private ensureVideoDecoder(keyframe: Uint8Array): void {
    const codec = codecFromAnnexB(keyframe) ?? FALLBACK_VIDEO_CODEC;
    const vdec = this.vdec!;
    if (codec !== this.codec || vdec.state !== 'configured') {
      vdec.configure({ codec, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
      this.codec = codec;
    }
  }

  private draw(frame: VideoFrame): void {
    const canvas = this.canvas;
    const ctx = this.ctx2d;
    if (!canvas || !ctx) return;
    const w = Math.min(MAX_DRAW_WIDTH, frame.displayWidth);
    const h = Math.round((w * frame.displayHeight) / frame.displayWidth);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(frame, 0, 0, w, h);
  }

  private teardown(): void {
    this.state = 'stopped';
    this.gen++;
    this.abort?.abort();
    this.closeSources();
    try {
      this.handle?.close();
    } catch {}
    cancelAnimationFrame(this.raf);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const d of this.videoPlayout.reset().decoded) d.frame.close();
    for (const dec of [this.vdec, this.adec]) {
      try {
        dec?.close();
      } catch {}
    }
    if (this.ac && !this.deps.audioContext) void this.ac.close().catch(() => {});
    this.gain?.disconnect();
  }
}
