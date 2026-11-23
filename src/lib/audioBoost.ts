import { logger } from './logger';

interface AudioGraph {
  audioContext: AudioContext;
  sourceNode: MediaElementAudioSourceNode;
  gainNode: GainNode;
  delayNode: DelayNode;
  compressorNode: DynamicsCompressorNode;
}

const videoGraphMap = new WeakMap<HTMLMediaElement, AudioGraph>();

export class AudioBoostManager {
  private boostPercent = 100; // 100% = 1.0x, 200% = 2.0x
  private audioDelaySec = 0; // 0.0s to 5.0s
  private currentElement: HTMLMediaElement | null = null;
  private isAvailable = true;

  constructor() {
    if (typeof localStorage === 'undefined') return;
    const savedBoost = localStorage.getItem('vidstack_player_volume_boost');
    if (savedBoost) {
      const parsed = parseFloat(savedBoost);
      if (!isNaN(parsed) && parsed >= 100 && parsed <= 200) {
        this.boostPercent = parsed;
      }
    }

    const savedDelay = localStorage.getItem('vidstack_player_audio_delay');
    if (savedDelay) {
      const parsed = parseFloat(savedDelay);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 5) {
        this.audioDelaySec = parsed;
      }
    }
  }

  public getBoost(): number {
    return this.boostPercent;
  }

  public getAudioDelay(): number {
    return this.audioDelaySec;
  }

  public attachToElement(video: HTMLMediaElement | null) {
    if (!video || typeof video.addEventListener !== 'function') {
      this.currentElement = null;
      return;
    }

    this.currentElement = video;

    // Conecta o grafo Web Audio se boost > 100% OU se áudio delay > 0s OU se já estiver conectado
    if (this.boostPercent <= 100 && this.audioDelaySec <= 0 && !videoGraphMap.has(video)) {
      return;
    }

    try {
      let graph = videoGraphMap.get(video);

      if (!graph) {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) {
          logger.warn('[Áudio] Este navegador não tem Web Audio: boost e atraso do áudio indisponíveis');
          this.isAvailable = false;
          return;
        }

        const audioContext = new AudioCtx();
        const sourceNode = audioContext.createMediaElementSource(video);
        const gainNode = audioContext.createGain();
        const delayNode = audioContext.createDelay(5.0); // max 5 seconds delay buffer
        const compressorNode = audioContext.createDynamicsCompressor();

        // Limitador suave perto de 0 dBFS: transparente em 100% e evita clipping no boost até 200%
        compressorNode.threshold.setValueAtTime(-1, audioContext.currentTime);
        compressorNode.knee.setValueAtTime(6, audioContext.currentTime);
        compressorNode.ratio.setValueAtTime(20, audioContext.currentTime);
        compressorNode.attack.setValueAtTime(0.002, audioContext.currentTime);
        compressorNode.release.setValueAtTime(0.15, audioContext.currentTime);

        // Chain: source -> gainNode -> delayNode -> compressor -> destination
        sourceNode.connect(gainNode);
        gainNode.connect(delayNode);
        delayNode.connect(compressorNode);
        compressorNode.connect(audioContext.destination);

        graph = { audioContext, sourceNode, gainNode, delayNode, compressorNode };
        videoGraphMap.set(video, graph);
        logger.info('[Áudio] Boost e atraso do áudio prontos');
        // Sincronização em tempo real do estado de reprodução para evitar vazamento de áudio com DelayNode
        const onPause = () => {
          if (graph) {
            try {
              const now = graph.audioContext.currentTime;
              graph.gainNode.gain.cancelScheduledValues(now);
              graph.gainNode.gain.setValueAtTime(0, now);
              if (graph.audioContext.state === 'running') {
                graph.audioContext.suspend().catch(() => {});
              }
            } catch {}
          }
        };

        const onPlay = () => {
          if (graph) {
            try {
              const now = graph.audioContext.currentTime;
              graph.gainNode.gain.cancelScheduledValues(now);
              graph.gainNode.gain.setValueAtTime(this.boostPercent / 100, now);
              graph.delayNode.delayTime.cancelScheduledValues(now);
              graph.delayNode.delayTime.setValueAtTime(this.audioDelaySec, now);
              if (graph.audioContext.state === 'suspended') {
                graph.audioContext.resume().catch(() => {});
              }
            } catch {}
          }
        };

        const onSeeking = () => {
          // Ao fazer seek, limpa o buffer acumulado no delayNode para não vazar áudio da posição anterior
          if (graph && this.audioDelaySec > 0) {
            try {
              const now = graph.audioContext.currentTime;
              graph.delayNode.delayTime.cancelScheduledValues(now);
              graph.delayNode.delayTime.setValueAtTime(0, now);
              graph.delayNode.delayTime.setValueAtTime(this.audioDelaySec, now + 0.05);
            } catch {}
          }
        };

        video.addEventListener('pause', onPause);
        video.addEventListener('play', onPlay);
        video.addEventListener('seeking', onSeeking);

        // Resume inicial se o navegador iniciar em modo suspenso
        if (graph.audioContext.state === 'suspended') {
          const initialResume = () => {
            graph?.audioContext.resume().catch(() => {});
          };
          video.addEventListener('play', initialResume, { once: true });
          video.addEventListener('click', initialResume, { once: true });
        }
      }

      this.applyGain(graph);
      this.applyDelay(graph);
    } catch (err) {
      // Possible CORS or AlreadyConnected error
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('CORS') || message.includes('cross-origin')) {
        logger.warn('[Áudio] Boost e atraso indisponíveis neste stream (CORS); usando o áudio normal', err);
      } else {
        logger.warn('[Áudio] Aviso ao conectar o Web Audio:', message);
      }
    }
  }

  private ensureElement(): HTMLMediaElement | null {
    if (this.currentElement && (typeof this.currentElement.isConnected !== 'boolean' || this.currentElement.isConnected)) {
      return this.currentElement;
    }
    this.currentElement = null;
    if (typeof document !== 'undefined') {
      const video = document.querySelector('#video-player-root video') as HTMLMediaElement | null;
      if (video) {
        this.currentElement = video;
        return video;
      }
    }
    return null;
  }

  public setBoost(percent: number) {
    const clamped = Math.max(100, Math.min(200, percent));
    this.boostPercent = clamped;
    if (typeof localStorage !== 'undefined') localStorage.setItem('vidstack_player_volume_boost', clamped.toString());

    const el = this.ensureElement();
    if (el) {
      if (clamped > 100) {
        this.attachToElement(el);
      }
      const graph = videoGraphMap.get(el);
      if (graph) {
        this.applyGain(graph);
      }
    }

    logger.setting('Volume boost', `${Math.round(clamped)}%`);
  }

  public setAudioDelay(delayInSeconds: number) {
    const clamped = Math.max(0, Math.min(5.0, Number(delayInSeconds.toFixed(3))));
    this.audioDelaySec = clamped;
    if (typeof localStorage !== 'undefined') localStorage.setItem('vidstack_player_audio_delay', clamped.toString());

    const el = this.ensureElement();
    if (el) {
      if (clamped > 0) {
        this.attachToElement(el);
      }
      const graph = videoGraphMap.get(el);
      if (graph) {
        this.applyDelay(graph);
      }
    }

    logger.setting('Atraso do áudio', `${Math.round(clamped * 1000)} ms`);
  }

  private resumeIfNeeded(graph: AudioGraph) {
    if (graph.audioContext.state === 'suspended' && this.currentElement && !this.currentElement.paused) {
      graph.audioContext.resume().catch(() => {});
    }
  }

  private applyGain(graph: AudioGraph) {
    // 100% -> gain 1.0; 200% -> gain 2.0
    const gainValue = this.boostPercent / 100;
    this.resumeIfNeeded(graph);
    try {
      graph.gainNode.gain.cancelScheduledValues(graph.audioContext.currentTime);
      graph.gainNode.gain.setValueAtTime(gainValue, graph.audioContext.currentTime);
    } catch {
      graph.gainNode.gain.value = gainValue;
    }
  }

  private applyDelay(graph: AudioGraph) {
    this.resumeIfNeeded(graph);
    try {
      graph.delayNode.delayTime.cancelScheduledValues(graph.audioContext.currentTime);
      graph.delayNode.delayTime.setValueAtTime(this.audioDelaySec, graph.audioContext.currentTime);
    } catch {
      graph.delayNode.delayTime.value = this.audioDelaySec;
    }
  }
}

export const audioBoost = new AudioBoostManager();
