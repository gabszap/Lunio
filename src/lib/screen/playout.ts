/**
 * Agendamento do espectador (lógica pura, sem navegador). Cópia do que a spike provou no PC e no celular fraco:
 * o ÁUDIO é o relógio mestre; o vídeo é entregue ao decodificador ~150 ms antes da hora (quadros decodificados em fila
 * travam o decodificador de hardware do celular) e só se descarta o que passou de 250 ms de atraso.
 */

/** Quadro de vídeo ainda codificado. `t` = carimbo da captura em ms. */
export interface EncodedVideo {
  t: number;
  key: boolean;
  data: Uint8Array;
}

const BASE_TARGET_S = 0.12;
const MAX_TARGET_S = 0.9;
const UNDERRUN_GROWTH = 1.4;
const RELAX_FACTOR = 0.95;
const TRIM_SLACK_S = 0.25;
const MIN_LEAD_S = 0.005;

export class AudioPlayout {
  underruns = 0;
  bufferedMs = 0;
  private target: number;
  private next = 0;
  private offsetS: number | null = null;
  private stamps: number[] = [];

  constructor(private readonly baseTargetS: number = BASE_TARGET_S) {
    this.target = baseTargetS;
  }

  get targetS(): number {
    return this.target;
  }

  /** Hora (no relógio do AudioContext) em que o bloco decodificado deve tocar. */
  schedule(ctxNow: number, durationS: number, stampMs: number): { startAt: number; underrun: boolean } {
    let underrun = false;
    if (this.next - ctxNow > this.target + TRIM_SLACK_S) this.next = ctxNow + this.target;
    if (this.next < ctxNow + MIN_LEAD_S) {
      if (this.next !== 0) {
        underrun = true;
        this.underruns++;
        this.target = Math.min(MAX_TARGET_S, this.target * UNDERRUN_GROWTH);
      }
      this.next = ctxNow + this.target;
    }
    const startAt = this.next;
    this.offsetS = startAt - stampMs / 1000;
    this.next += durationS;
    this.bufferedMs = Math.round((this.next - ctxNow) * 1000);
    return { startAt, underrun };
  }

  /** A cada 1 s sem falhas: o alvo volta a descer, sem passar do mínimo. */
  relax(): void {
    this.target = Math.max(this.baseTargetS, this.target * RELAX_FACTOR);
  }

  /** O que está sendo ouvido agora, no tempo da captura (ms). `null` antes do primeiro áudio. */
  mediaTimeMs(ctxNow: number, outputLatencyS: number): number | null {
    return this.offsetS === null ? null : (ctxNow - outputLatencyS - this.offsetS) * 1000;
  }

  /** O `AudioDecoder` do Chromium não segue o timestamp de entrada depois de um buraco: o carimbo vem desta fila. */
  pushStamp(stampMs: number): void {
    this.stamps.push(stampMs);
  }

  shiftStamp(fallbackMs: number): number {
    return this.stamps.length ? this.stamps.shift()! : fallbackMs;
  }

  /** Pausa/retomada: recomeça o relógio e a fila, mas mantém o alvo que a rede já ensinou. */
  reset(): void {
    this.next = 0;
    this.offsetS = null;
    this.stamps.length = 0;
    this.bufferedMs = 0;
  }
}

/**
 * Relógio do vídeo para transmissão SEM áudio (válida: o áudio é opcional): sem áudio não há relógio mestre. Espera 1 s
 * de vídeo, ancora no quadro mais novo menos um buffer e passa a andar com o relógio de parede.
 */
export class VideoOnlyClock {
  private firstSeenAt: number | null = null;
  private latestStamp = -Infinity;
  private offset: number | null = null;

  constructor(
    private readonly waitMs = 1000,
    private readonly bufferMs = 300,
  ) {}

  note(stampMs: number, nowMs: number): void {
    if (!Number.isFinite(stampMs)) return;
    if (this.firstSeenAt === null) this.firstSeenAt = nowMs;
    this.latestStamp = Math.max(this.latestStamp, stampMs);
  }

  mediaTimeMs(nowMs: number): number | null {
    if (this.offset === null) {
      if (this.firstSeenAt === null || nowMs - this.firstSeenAt < this.waitMs) return null;
      this.offset = nowMs - (this.latestStamp - this.bufferMs);
    }
    return nowMs - this.offset;
  }

  reset(): void {
    this.firstSeenAt = null;
    this.latestStamp = -Infinity;
    this.offset = null;
  }
}

export class VideoPlayout<F extends { t: number }> {
  readonly LEAD_MS = 150 as const;
  readonly DROP_LATE_MS = 250 as const;
  readonly SKIP_AHEAD_MS = 1500 as const;
  readonly MAX_DECODED = 8 as const;
  readonly MAX_DECODE_QUEUE = 8 as const;

  /** ~10 s a 30 fps: mais que isso parado é aba em segundo plano, decodificador travado ou carimbo ruim. */
  readonly MAX_ENCODED = 300 as const;

  needKey = true;
  private encoded: EncodedVideo[] = [];
  private decoded: F[] = [];

  get pendingCount(): number {
    return this.encoded.length;
  }

  enqueue(e: EncodedVideo): void {
    if (!Number.isFinite(e.t)) return;
    this.encoded.push(e);
    if (this.encoded.length > this.MAX_ENCODED) this.trimToLatestKeyframe();
  }

  /** Fila estourou: volta ao quadro-chave mais recente; sem nenhum, descarta tudo e espera o próximo. */
  private trimToLatestKeyframe(): void {
    const q = this.encoded;
    for (let i = q.length - 1; i > 0; i--) {
      if (q[i].key) {
        q.splice(0, i);
        return;
      }
    }
    q.length = 0;
    this.needKey = true;
  }

  /** O decodificador recusou um quadro: recomeça num quadro-chave. */
  markNeedKey(): void {
    this.needKey = true;
  }

  /** Quadros que vão ao decodificador agora (os que serão mostrados nos próximos LEAD ms); `S` = relógio do áudio em ms. */
  takeForDecode(S: number, decodeQueueSize: number): { chunks: EncodedVideo[]; skipped: number } {
    let skipped = 0;
    const q = this.encoded;
    // Atraso grande demais: pula para o último quadro-chave já vencido
    if (q.length && q[0].t < S - this.SKIP_AHEAD_MS) {
      let k = -1;
      for (let i = 0; i < q.length && q[i].t <= S; i++) if (q[i].key) k = i;
      if (k > 0) {
        skipped = k;
        q.splice(0, k);
      }
    }
    const chunks: EncodedVideo[] = [];
    while (q.length && q[0].t <= S + this.LEAD_MS && decodeQueueSize + chunks.length < this.MAX_DECODE_QUEUE) {
      const c = q.shift()!;
      if (this.needKey && !c.key) continue;
      chunks.push(c);
      this.needKey = false;
    }
    return { chunks, skipped };
  }

  /** Quadro que o decodificador entregou. Devolve os que passaram do limite da fila (quem chama os fecha). */
  addDecoded(f: F): F[] {
    this.decoded.push(f);
    const dropped: F[] = [];
    while (this.decoded.length > this.MAX_DECODED) dropped.push(this.decoded.shift()!);
    return dropped;
  }

  /** Um quadro por vez, em ordem; descarta só o que está > 250 ms atrasado e já tem um mais novo esperando. */
  pick(S: number): { frame: F | null; dropped: F[] } {
    const dropped: F[] = [];
    const d = this.decoded;
    if (!d.length || d[0].t > S) return { frame: null, dropped };
    while (d.length > 1 && d[1].t <= S - this.DROP_LATE_MS) dropped.push(d.shift()!);
    return { frame: d.shift()!, dropped };
  }

  /** Pausa/retomada: limpa tudo e exige quadro-chave. Devolve os decodificados para quem chama fechar. */
  reset(): { pending: number; decoded: F[] } {
    const decoded = this.decoded;
    const pending = this.encoded.length;
    this.decoded = [];
    this.encoded = [];
    this.needKey = true;
    return { pending, decoded };
  }
}
