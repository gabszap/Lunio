/**
 * Relógio da captura -> relógio de parede. O carimbo de cada quadro é o instante em que ele foi CAPTURADO (não quando
 * foi lido: a leitura chega em lotes) somado a um offset que é o mínimo de `agora - captura` já visto. O mínimo sobe
 * devagar (0,02 ms por amostra) para acompanhar a deriva dos relógios sem acompanhar o atraso das leituras.
 */
const OFFSET_RELAX_MS = 0.02;

export class CaptureClock {
  private offset: number | null = null;

  stamp(captureMs: number, nowMs: number): number {
    const candidate = nowMs - captureMs;
    this.offset = this.offset === null ? candidate : Math.min(this.offset + OFFSET_RELAX_MS, candidate);
    return this.offset + captureMs;
  }

  reset(): void {
    this.offset = null;
  }
}

/** A captura vem a 60 fps: deixa passar só o que cabe no fps de saída (com 4 ms de folga para o relógio oscilar). */
export class FrameDecimator {
  private last: number | null = null;

  constructor(private readonly outFps: number) {}

  shouldEncode(captureMs: number): boolean {
    if (this.last !== null && captureMs - this.last < 1000 / this.outFps - 4) return false;
    this.last = captureMs;
    return true;
  }

  reset(): void {
    this.last = null;
  }
}
