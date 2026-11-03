/**
 * Nível mínimo do H.264 que comporta macroblocos por quadro e por segundo (tabela do padrão). Colunas:
 * id do nível, macroblocos/s, macroblocos/quadro. 4.0 cobre 1080p30 e 4.2 cobre 1080p60.
 */
const LEVELS: ReadonlyArray<readonly [number, number, number]> = [
  [0x1f, 108000, 3600],
  [0x20, 216000, 5120],
  [0x28, 245760, 8192],
  [0x2a, 522240, 8704],
  [0x32, 589824, 22080],
  [0x33, 983040, 36864],
  [0x34, 2073600, 36864],
];

export function avcCodecFor(width: number, height: number, fps: number): string {
  const perFrame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const perSecond = perFrame * fps;
  const level = LEVELS.find((l) => perFrame <= l[2] && perSecond <= l[1]) ?? LEVELS[LEVELS.length - 1];
  return 'avc1.6400' + level[0].toString(16).padStart(2, '0');
}

const hex = (n: number) => n.toString(16).padStart(2, '0');

/** Perfil/nível do quadro-chave em Annex-B: lê o SPS (NAL 7) nos primeiros 200 bytes. */
export function codecFromAnnexB(data: Uint8Array): string | null {
  const limit = Math.min(data.length, 200);
  for (let i = 0; i + 4 < limit; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    let n: number;
    if (data[i + 2] === 1) n = i + 3;
    else if (data[i + 2] === 0 && data[i + 3] === 1) n = i + 4;
    else continue;
    if (n + 3 < data.length && (data[n] & 0x1f) === 7) return 'avc1.' + hex(data[n + 1]) + hex(data[n + 2]) + hex(data[n + 3]);
  }
  return null;
}
