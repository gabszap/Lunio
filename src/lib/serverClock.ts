const SAMPLES = 8;

/**
 * A hora do servidor vista deste computador, medida pelas idas e voltas do heartbeat (como o NTP).
 *
 * A sala carimba as posições com a hora do servidor; usar `Date.now()` daqui faria um relógio adiantado ou
 * atrasado virar atraso (ou adianto) no vídeo. A leitura vem de `performance.now()`, que não pula quando o
 * horário do sistema é mudado. Das últimas medições vale a de menor ida e volta, que diz mais sobre o desvio.
 */
export class ServerClock {
  private samples: { offset: number; rtt: number }[] = [];
  private offset = 0;
  rtt = 0;

  constructor(
    private readonly mono: () => number = () => performance.now(),
    private readonly wall: () => number = () => Date.now()
  ) {}

  get synced(): boolean {
    return this.samples.length > 0;
  }

  /** `t0` e `t3`: leitura monotônica no envio e na volta; `serverTime`: hora do servidor ao responder. */
  add(t0: number, t3: number, serverTime: number): void {
    const rtt = t3 - t0;
    if (!(rtt >= 0) || !Number.isFinite(serverTime)) return;
    this.samples = [...this.samples.slice(-(SAMPLES - 1)), { offset: serverTime - (t0 + t3) / 2, rtt }];
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
    this.rtt = best.rtt;
  }

  /** A hora do servidor agora; antes da primeira medição, a do próprio computador. */
  now(): number {
    return this.synced ? this.mono() + this.offset : this.wall();
  }

  reset(): void {
    this.samples = [];
    this.offset = 0;
    this.rtt = 0;
  }
}
