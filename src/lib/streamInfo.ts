// Só o que decide se o navegador toca o stream. Resolução, tamanho e idiomas ficam
// no texto do addon, que a lista mostra como veio.

export interface StreamCodecs {
  videoCodec?: 'h264' | 'hevc' | 'av1' | 'vp9';
  dolbyVision: boolean;
  audio: Array<'aac' | 'ac3' | 'eac3' | 'dts' | 'truehd' | 'opus'>;
}

// Fronteira de "palavra" que trata ponto, hífen e emoji como separador.
const B = '(?<![a-z0-9])';
const E = '(?![a-z0-9])';

const VIDEO: Array<[NonNullable<StreamCodecs['videoCodec']>, RegExp]> = [
  ['hevc', new RegExp(`${B}(hevc|h[. ]?265|x265)${E}`, 'i')],
  ['h264', new RegExp(`${B}(avc|h[. ]?264|x264)${E}`, 'i')],
  ['av1', new RegExp(`${B}av1${E}`, 'i')],
  ['vp9', new RegExp(`${B}vp9${E}`, 'i')],
];

const AUDIO: Array<[StreamCodecs['audio'][number], RegExp]> = [
  ['eac3', new RegExp(`${B}(dd\\+|ddp\\d*|e-?ac-?3)`, 'i')],
  // DD+ e E-AC3 são eac3: o "+" e o "-" antes de "AC3" tiram o caso do ac3.
  ['ac3', new RegExp(`${B}dd(?![a-z+])|(?<![a-z0-9-])ac-?3${E}`, 'i')],
  ['aac', new RegExp(`${B}aac${E}`, 'i')],
  ['opus', new RegExp(`${B}opus${E}`, 'i')],
  ['dts', new RegExp(`${B}dts`, 'i')],
  ['truehd', new RegExp(`${B}truehd${E}`, 'i')],
];

const DOLBY_VISION = new RegExp(`${B}dv${E}|dolby[ .-]?vision`, 'i');

function firstVideo(text: string): StreamCodecs['videoCodec'] {
  return VIDEO.find(([, re]) => re.test(text))?.[0];
}

export function detectCodecs(s: { name?: string; description?: string; filename?: string }): StreamCodecs {
  const text = [s.filename, s.name, s.description].filter(Boolean).join('\n');
  // O nome do arquivo é o mais confiável: vale primeiro para o vídeo.
  const videoCodec = (s.filename && firstVideo(s.filename)) || firstVideo(text);
  const result: StreamCodecs = {
    dolbyVision: DOLBY_VISION.test(text),
    audio: AUDIO.filter(([, re]) => re.test(text)).map(([id]) => id),
  };
  if (videoCodec) result.videoCodec = videoCodec;
  return result;
}
