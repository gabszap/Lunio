import { BoundedCache } from '../cache';
import { config } from '../config';

/**
 * Quanto o FFmpeg lê de cada CDN por segundo. O extrator de legendas (Python) usa isso para decidir entre as muitas
 * requisições Range dele e deixar o FFmpeg ler o arquivo todo. Começa em `FFMPEG_THROUGHPUT_MBPS` e, a cada leitura
 * completa de verdade, passa a valer a média móvel medida daquele host (CDNs e horários diferentes, velocidades diferentes).
 */

/** Abaixo disto a partida do FFmpeg pesa mais que a leitura e a conta sai subestimada: não entra na média. */
const MIN_SAMPLE_BYTES = 50 * 1024 * 1024;
const MIN_MBPS = 5;
const MAX_MBPS = 200;
/** Peso da amostra nova na média (o resto fica com o histórico): uma leitura ruim não derruba a estimativa sozinha. */
const NEW_SAMPLE_WEIGHT = 0.3;

const byHost = new BoundedCache<{ mbps: number; samples: number }>(200, 24 * 3600 * 1000);

/** MB/s (1 MB = 1.000.000 bytes, como no extrator) para decidir extrator ou FFmpeg neste host. */
export function ffmpegMbpsFor(host: string): number {
  return byHost.get(host)?.mbps ?? config.ffmpegThroughputMbps;
}

/** Quantas leituras reais já entraram na média deste host (0 = ainda vale o padrão). */
export function ffmpegSamplesFor(host: string): number {
  return byHost.get(host)?.samples ?? 0;
}

/**
 * Registra uma leitura completa do arquivo pelo FFmpeg. Devolve a nova estimativa, ou null se a amostra não vale
 * (arquivo pequeno demais ou tempo inválido).
 */
export function recordFfmpegRead(host: string, bytes: number, elapsedMs: number): number | null {
  if (!host || !Number.isFinite(bytes) || bytes < MIN_SAMPLE_BYTES || !Number.isFinite(elapsedMs) || elapsedMs < 500) return null;
  const sample = Math.min(MAX_MBPS, Math.max(MIN_MBPS, bytes / 1_000_000 / (elapsedMs / 1000)));
  const prev = byHost.get(host);
  const mbps = prev ? prev.mbps * (1 - NEW_SAMPLE_WEIGHT) + sample * NEW_SAMPLE_WEIGHT : sample;
  const samples = (prev?.samples ?? 0) + 1;
  byHost.set(host, { mbps, samples });
  console.log(`[Subtitle] 📏 FFmpeg leu ${(bytes / 1_000_000).toFixed(0)} MB de ${host} em ${(elapsedMs / 1000).toFixed(1)} s (${sample.toFixed(0)} MB/s); estimativa agora ${mbps.toFixed(0)} MB/s (${samples} leitura${samples > 1 ? 's' : ''}).`);
  return mbps;
}

/** Só para testes. */
export function resetFfmpegSpeed() {
  byHost.clear();
}
