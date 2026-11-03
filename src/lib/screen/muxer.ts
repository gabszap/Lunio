import type { TrackSink } from './transport';
import type { FrameSealer } from './wire';

/** Um grupo de áudio a cada 1 s de mídia: um grupo por frame faz a Cloudflare derrubar a faixa em ~20 s. */
export const AUDIO_GROUP_MS = 1000;

/**
 * Recebe os quadros já codificados, cifra e escreve nas faixas com a regra de grupos (vídeo: um por quadro-chave;
 * áudio: um por segundo). A cifra é assíncrona, então cada faixa tem a sua fila para manter a ordem.
 */
export class FrameMuxer {
  /** Soma dos payloads escritos (cifrados, com cabeçalho): o que o Host de fato publicou. */
  bytesOut = 0;
  /** Quadros que não foram escritos (sem chave, delta antes do 1º quadro-chave, falha ao cifrar ou escrever). */
  dropped = 0;

  private chainV: Promise<void> = Promise.resolve();
  private chainA: Promise<void> = Promise.resolve();
  private videoOpen = false;
  private audioGroupStartUs: number | null = null;

  constructor(
    private readonly sealer: FrameSealer,
    private readonly sinks: { video: TrackSink; audio: TrackSink },
  ) {}

  pushVideo(c: { key: boolean; data: Uint8Array; timestampUs: number }, stamp: number): void {
    if (this.sealer.epoch === 0 || (!this.videoOpen && !c.key)) {
      this.dropped++;
      return;
    }
    if (c.key) this.videoOpen = true;
    this.chainV = this.chainV.then(() => this.write('video', this.sinks.video, c.data, c.timestampUs, stamp, c.key, c.key));
  }

  pushAudio(c: { data: Uint8Array; timestampUs: number }, stamp: number): void {
    if (this.sealer.epoch === 0) {
      this.dropped++;
      return;
    }
    const newGroup = this.audioGroupStartUs === null || c.timestampUs - this.audioGroupStartUs >= AUDIO_GROUP_MS * 1000;
    if (newGroup) this.audioGroupStartUs = c.timestampUs;
    this.chainA = this.chainA.then(() => this.write('audio', this.sinks.audio, c.data, c.timestampUs, stamp, true, newGroup));
  }

  /** Resolve quando tudo o que entrou já foi escrito. */
  async flush(): Promise<void> {
    await Promise.all([this.chainV, this.chainA]);
  }

  private async write(
    kind: 'video' | 'audio',
    sink: TrackSink,
    data: Uint8Array,
    timestampUs: number,
    stamp: number,
    isKey: boolean,
    newGroup: boolean,
  ): Promise<void> {
    try {
      const payload = await this.sealer.seal(kind, stamp, isKey, data);
      sink.write(payload, timestampUs, newGroup);
      this.bytesOut += payload.length;
    } catch {
      this.dropped++;
    }
  }
}
