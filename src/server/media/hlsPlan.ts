/**
 * Plano de segmentos do HLS compartilhado. O vídeo é copiado (não recodificado), então cada segmento precisa
 * começar num keyframe: os limites saem dos Cues do MKV, escolhidos para dar segmentos de ~6 s.
 */

export interface HlsPlan {
  /** Duração total do vídeo, em segundos. */
  duration: number;
  /** Início de cada segmento + o fim do último. `boundaries.length - 1` = quantidade de segmentos. */
  boundaries: number[];
}

export const TARGET_SEGMENT_SECONDS = 6;
/** O FFmpeg, ao buscar `-ss`, recua ~0,13 s (compensa B-frames); somamos isso para cair exatamente no keyframe. */
export const SEEK_COMPENSATION = 0.14;
/** Keyframes colados (< 0,2 s do seguinte) não servem de limite: o `-ss` poderia cair no vizinho. */
const MIN_GAP_AFTER_BOUNDARY = 0.2;

export function buildPlan(keyframes: number[], duration: number, target = TARGET_SEGMENT_SECONDS): HlsPlan {
  const sorted = [...new Set(keyframes.filter((t) => Number.isFinite(t) && t >= 0 && t < duration))].sort((a, b) => a - b);
  const boundaries = [0];
  let last = 0;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    if (t - last < target - 0.25) continue;
    const next = sorted[i + 1];
    if (next !== undefined && next - t < MIN_GAP_AFTER_BOUNDARY) continue;
    boundaries.push(t);
    last = t;
  }
  // Fim do último segmento; se sobrar um rabinho (< 1 s), junta ao anterior
  if (boundaries.length > 1 && duration - last < 1) boundaries.pop();
  boundaries.push(duration);
  return { duration, boundaries };
}

export function segmentCount(plan: HlsPlan): number {
  return plan.boundaries.length - 1;
}

export function segmentDuration(plan: HlsPlan, index: number): number {
  return plan.boundaries[index + 1] - plan.boundaries[index];
}

/** Playlist VOD completa; `query` (ex.: `?t=<token>`) é anexado a cada segmento porque o player não manda cabeçalhos. */
export function buildPlaylist(plan: HlsPlan, query = ''): string {
  const n = segmentCount(plan);
  let longest = 0;
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = segmentDuration(plan, i);
    longest = Math.max(longest, d);
    lines.push(`#EXTINF:${d.toFixed(3)},`, `${i}.ts${query}`);
  }
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(longest)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    ...lines,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}
