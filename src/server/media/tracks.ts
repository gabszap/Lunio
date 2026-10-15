import { BoundedCache } from '../cache';
import { parseTorrentTitle } from '@viren070/parse-torrent-title';
import { extractFilenameFromUrl } from './fingerprint';

/** O vídeo principal do arquivo (só para o navegador avisar se não decodifica; o servidor nunca recodifica vídeo). */
export interface VideoInfo {
  /** Nome do codec no FFmpeg: h264, hevc, av1, vp9, vp8, mpeg4… */
  codec: string;
  /** Perfil, quando o FFmpeg informa (ex.: "Main 10"). */
  profile: string;
  /** Formato de pixel (ex.: yuv420p10le): dá a profundidade de cor. */
  pixFmt: string;
  width: number;
  height: number;
}

export interface TracksResult {
  title: string;
  rawTitle: string;
  duration: number;
  parsedTorrent: any;
  audios: any[];
  subtitles: any[];
  chapters: any[];
  fonts: any[];
  /** `null` quando o arquivo não tem vídeo ou a linha não pôde ser lida. */
  video?: VideoInfo | null;
  streamUrl: string;
}

/** Resultado da inspeção por URL (evita rodar o FFmpeg de novo para o mesmo vídeo). */
export const tracksCache = new BoundedCache<TracksResult>(300, 6 * 3600 * 1000);

/**
 * A linha do vídeo principal como o FFmpeg a escreveu, para o journal: com o tempo mostra os formatos reais que
 * passam por aqui e confere o `parseVideoLine`. Sem URL nem texto longo (a linha só descreve o stream).
 */
export function videoLineForLog(stderr: string): string | null {
  for (const raw of stderr.split('\n')) {
    const line = raw.replace(/\r/g, '').trim();
    if (!/^Stream #0:\d+.*Video:/.test(line) || /attached pic/i.test(line)) continue;
    return line.replace(/https?:\/\/\S+/gi, '[url]').slice(0, 300);
  }
  return null;
}

/** `Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, progressive), 3840x2160 [SAR 1:1 DAR 16:9], 24 fps…` */
export function parseVideoLine(line: string): VideoInfo | null {
  const m = line.match(/Video:\s*([A-Za-z0-9_]+)((?:\s*\([^)]*\))*)/);
  if (!m) return null;
  const size = line.match(/,\s*(\d{2,5})x(\d{2,5})\b/);
  const pix = line.match(/,\s*((?:yuvj?|gbrap?|gray|nv|p0|rgb|bgr|argb|bgra|pal)[a-z0-9]*)/i);
  // Os parênteses depois do codec misturam decodificador ("libdav1d"), etiqueta do contêiner ("avc1 / 0x31637661") e
  // perfil ("Main 10"): só o perfil interessa
  const profile =
    [...(m[2] || '').matchAll(/\(([^)]*)\)/g)]
      .map((g) => g[1].trim())
      .find((p) => p && !/0x[0-9a-f]+/i.test(p) && !/^(lib|native|h264_|hevc_)/i.test(p)) || '';
  return {
    codec: m[1].toLowerCase(),
    profile,
    pixFmt: pix ? pix[1].toLowerCase() : '',
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
  };
}

/** Interpreta a saída de `ffmpeg -i` (stderr): faixas de áudio/legenda/anexos, capítulos, duração e título. */
export function parseTracks(stderr: string, targetUrl: string, streamUrl: string): TracksResult {
  const audios: any[] = [];
  const subtitles: any[] = [];
  const chapters: any[] = [];
  const fonts: any[] = [];
  let video: VideoInfo | null = null;

  // Sanitiza todas as linhas removendo retornos de carro (\r do Windows) e espaços
  const rawLines = stderr.split('\n');
  const streamLines = rawLines.map((l) => l.replace(/\r/g, '').trim()).filter(Boolean);

  let currentStream: any = null;
  let currentChapter: any = null;
  let mediaTitle = '';

  for (const line of streamLines) {
    // Parse de Capítulos: Chapter #0:1: start 706.000000, end 802.000000
    const chapterMatch = line.match(/^Chapter #0:(\d+): start ([\d.]+), end ([\d.]+)/i);
    if (chapterMatch) {
      currentStream = null;
      const cIndex = parseInt(chapterMatch[1], 10);
      const cStart = parseFloat(chapterMatch[2]);
      const cEnd = parseFloat(chapterMatch[3]);
      currentChapter = {
        index: cIndex,
        startTime: cStart,
        endTime: cEnd,
        title: '',
      };
      chapters.push(currentChapter);
      continue;
    }

    // Parse de Streams (suporta Audio, Subtitle, Video e Attachment para fontes embutidas)
    const streamMatch = line.match(/^Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?(?:\[[^\]]+\])?:\s*(Audio|Subtitle|Video|Attachment):\s*([^,\n\r]+)/i);
    if (streamMatch) {
      currentChapter = null;
      const index = parseInt(streamMatch[1], 10);
      const lang = (streamMatch[2] || 'und').toLowerCase();
      const type = streamMatch[3].toLowerCase();
      const codec = streamMatch[4].trim();
      const lineLower = line.toLowerCase();
      // Primeiro vídeo de verdade (capa de álbum/anexo "attached pic" não conta)
      if (type === 'video' && !video && !lineLower.includes('attached pic')) video = parseVideoLine(line);
      const isForced = lineLower.includes('forced');
      const isDefault = lineLower.includes('default');

      currentStream = {
        index,
        type,
        codec,
        language: lang,
        title: '',
        filename: '',
        mimetype: '',
        isForced,
        isDefault,
      };

      if (type === 'audio') {
        audios.push(currentStream);
      } else if (type === 'subtitle') {
        subtitles.push(currentStream);
      } else if (type === 'attachment') {
        fonts.push(currentStream);
      }
      continue;
    }

    // Metadados de Anexo (fontes embutidas TTF/OTF)
    const filenameMatch = line.match(/^filename\s*:\s*(.+)$/i);
    if (filenameMatch && currentStream) {
      currentStream.filename = filenameMatch[1].trim();
      if (!currentStream.title) currentStream.title = currentStream.filename;
      continue;
    }
    const mimetypeMatch = line.match(/^mimetype\s*:\s*(.+)$/i);
    if (mimetypeMatch && currentStream) {
      currentStream.mimetype = mimetypeMatch[1].trim();
      continue;
    }

    // Títulos de Streams ou Chapters (suporta title, name, chapter_name)
    const metaTitleMatch = line.match(/^(?:title|name|chapter_name)\s*:\s*(.+)$/i);
    if (metaTitleMatch) {
      const parsedTitle = metaTitleMatch[1].trim();
      if (!currentChapter && !currentStream && !mediaTitle) {
        mediaTitle = parsedTitle;
        continue;
      }
      if (currentChapter && !currentChapter.title) {
        currentChapter.title = parsedTitle;
        currentChapter = null;
        continue;
      }
      if (currentStream && !currentStream.title) {
        currentStream.title = parsedTitle;
        const titleLower = parsedTitle.toLowerCase();
        if (titleLower.includes('forced') || titleLower.includes('sign') || titleLower.includes('song') || titleLower.includes('placa')) {
          currentStream.isForced = true;
        }
        continue;
      }
    }
  }

  // Preenche fallback apenas para capítulos que realmente não tinham título no arquivo
  chapters.forEach((c) => {
    if (!c.title || c.title.trim() === '') {
      c.title = `Capítulo ${c.index + 1}`;
    }
  });

  // Normaliza títulos de áudio
  function formatAudioTitle(a: any): string {
    const lang = (a.language || '').toLowerCase();
    const rawTitle = (a.title || '').trim();
    const t = rawTitle.toLowerCase();

    if (lang.includes('chi') || lang.includes('zh') || t.includes('zh-cn') || t.includes('mandar')) {
      return '🇨🇳 Chinês (Mandarim Original)';
    }
    if (lang.includes('jpn') || lang.includes('ja') || t.includes('ja-jp') || t.includes('japon')) {
      return '🇯🇵 Japonês';
    }
    if (lang.includes('por') || lang.includes('pt') || t.includes('pt-br') || t.includes('portug')) {
      return '🇧🇷 Português (Brasil)';
    }
    if (lang.includes('eng') || lang.includes('en') || t.includes('en-us')) {
      return '🇺🇸 Inglês';
    }
    if (t.includes('es-419') || t.includes('latino') || (lang.includes('spa') && !t.includes('es-es'))) {
      return '🇲🇽 Espanhol (Latino)';
    }
    if (t.includes('es-es') || t.includes('castellano') || t.includes('spain')) {
      return '🇪🇸 Espanhol (Espanha)';
    }
    if (lang.includes('fre') || lang.includes('fra') || lang.includes('fr')) return '🇫🇷 Francês';
    if (lang.includes('ger') || lang.includes('deu') || lang.includes('de')) return '🇩🇪 Alemão';
    if (lang.includes('ita') || lang.includes('it')) return '🇮🇹 Italiano';
    if (lang.includes('rus') || lang.includes('ru')) return '🇷🇺 Russo';
    if (lang.includes('kor') || lang.includes('ko')) return '🇰🇷 Coreano';
    if (lang.includes('ara') || lang.includes('ar')) return '🇸🇦 Árabe';
    return rawTitle || (lang !== 'und' ? lang.toUpperCase() : `Áudio #${a.index}`);
  }

  audios.forEach((a) => {
    a.title = formatAudioTitle(a);
  });

  // Português do Brasil x de Portugal: o arquivo marca as duas como "por" (ex.: Netflix usa só o título,
  // "NF_Portuguese(Brazil)" e "NF_Portuguese"). A que diz Brasil/Portugal explicitamente manda; a sem marca
  // é a outra variante quando a irmã é explícita, e Brasil quando não há nenhuma pista (como sempre foi).
  const isPortuguese = (s: any) => {
    const lang = (s.language || '').toLowerCase();
    const t = (s.title || '').toLowerCase();
    return lang.includes('por') || lang.includes('pt') || t.includes('pt-br') || t.includes('portug');
  };
  const explicitVariant = (s: any): 'br' | 'pt' | null => {
    const t = (s.title || '').toLowerCase();
    const lang = (s.language || '').toLowerCase();
    if (t.includes('pt-pt') || t.includes('portugal') || t.includes('european') || lang.includes('pt-pt')) return 'pt';
    if (t.includes('pt-br') || t.includes('brazil') || t.includes('brasil') || lang.includes('pt-br')) return 'br';
    return null;
  };
  const ptTracks = subtitles.filter(isPortuguese);
  const hasExplicitBr = ptTracks.some((s) => explicitVariant(s) === 'br');
  const hasExplicitPt = ptTracks.some((s) => explicitVariant(s) === 'pt');
  const ptVariantOf = (s: any): 'br' | 'pt' =>
    explicitVariant(s) ?? (hasExplicitBr && !hasExplicitPt ? 'pt' : 'br');
  const variantsPresent = new Set(ptTracks.map(ptVariantOf));
  const bothPtVariants = variantsPresent.size > 1;

  // Normaliza legendas com suporte completo a línguas mundiais
  subtitles.forEach((s) => {
    const lang = (s.language || '').toLowerCase();
    const rawTitle = (s.title || '').trim();
    const t = rawTitle.toLowerCase();
    const isForced = s.isForced || t.includes('forced') || t.includes('sign') || t.includes('song') || t.includes('placa');
    const isCaptions = t.includes('caption') || t.includes('sdh');

    let baseName = '';
    let flag = '';

    if (lang.includes('por') || lang.includes('pt') || t.includes('pt-br') || t.includes('portug')) {
      const variant = ptVariantOf(s);
      // "(Brasil)" só aparece quando o arquivo tem as duas variantes; com uma só, "Português" como antes
      baseName = variant === 'pt' ? 'Português (Portugal)' : bothPtVariants ? 'Português (Brasil)' : 'Português';
      flag = variant === 'pt' ? '🇵🇹 ' : '🇧🇷 ';
    } else if (lang.includes('eng') || lang.includes('en') || t.includes('en-us')) {
      baseName = 'Inglês';
      flag = '🇺🇸 ';
    } else if (t.includes('es-es') || t.includes('castellano') || t.includes('spain') || t.includes('european') || t.includes('europeo') || t.includes('europe')) {
      baseName = 'Espanhol (Espanha)';
      flag = '🇪🇸 ';
    } else if (lang.includes('spa') || lang.includes('es') || t.includes('es-419') || t.includes('latino')) {
      baseName = 'Espanhol (Latino)';
      flag = '🇲🇽 ';
    } else if (lang.includes('fre') || lang.includes('fra') || lang.includes('fr')) {
      baseName = 'Francês';
      flag = '🇫🇷 ';
    } else if (lang.includes('ger') || lang.includes('deu') || lang.includes('de')) {
      baseName = 'Alemão';
      flag = '🇩🇪 ';
    } else if (lang.includes('ita') || lang.includes('it')) {
      baseName = 'Italiano';
      flag = '🇮🇹 ';
    } else if (lang.includes('rus') || lang.includes('ru')) {
      baseName = 'Russo';
      flag = '🇷🇺 ';
    } else if (lang.includes('chi') || lang.includes('zh') || lang.includes('zho')) {
      if (t.includes('hong kong') || t.includes('hk') || t.includes('canton')) {
        baseName = 'Chinês (Hong Kong / Tradicional)';
        flag = '🇭🇰 ';
      } else if (t.includes('mandar') || t.includes('putonghua')) {
        baseName = 'Chinês (Mandarim)';
        flag = '🇨🇳 ';
      } else if (t.includes('trad') || t.includes('hant') || t.includes('taiwan') || t.includes('tw')) {
        baseName = 'Chinês (Tradicional)';
        flag = '🇨🇳 ';
      } else if (t.includes('simp') || t.includes('hans') || t.includes('china')) {
        baseName = 'Chinês (Simplificado)';
        flag = '🇨🇳 ';
      } else {
        baseName = 'Chinês';
        flag = '🇨🇳 ';
      }
    } else if (lang.includes('jpn') || lang.includes('ja')) {
      baseName = 'Japonês';
      flag = '🇯🇵 ';
    } else if (lang.includes('kor') || lang.includes('ko')) {
      baseName = 'Coreano';
      flag = '🇰🇷 ';
    } else if (lang.includes('ara') || lang.includes('ar')) {
      baseName = 'Árabe';
      flag = '🇸🇦 ';
    } else if (lang.includes('hin') || lang.includes('hi')) {
      baseName = 'Hindi';
      flag = '🇮🇳 ';
    } else if (lang.includes('tur') || lang.includes('tr')) {
      baseName = 'Turco';
      flag = '🇹🇷 ';
    } else if (lang.includes('pol') || lang.includes('pl')) {
      baseName = 'Polonês';
      flag = '🇵🇱 ';
    } else if (lang.includes('dut') || lang.includes('nld') || lang.includes('nl')) {
      baseName = 'Holandês';
      flag = '🇳🇱 ';
    } else if (lang.includes('ind') || lang.includes('id')) {
      baseName = 'Indonésio';
      flag = '🇮🇩 ';
    } else if (lang.includes('may') || lang.includes('msa') || lang === 'ms' || t.includes('malay') || t.includes('malaio')) {
      baseName = 'Malaio';
      flag = '🇲🇾 ';
    } else if (lang.includes('swe') || lang.includes('sv')) {
      baseName = 'Sueco';
      flag = '🇸🇪 ';
    } else if (lang.includes('tha') || lang.includes('th')) {
      baseName = 'Tailandês';
      flag = '🇹🇭 ';
    } else if (lang.includes('vie') || lang.includes('vi')) {
      baseName = 'Vietnamita';
      flag = '🇻🇳 ';
    } else if (lang.includes('ukr') || lang.includes('uk')) {
      baseName = 'Ucraniano';
      flag = '🇺🇦 ';
    } else if (lang.includes('cze') || lang.includes('ces') || lang.includes('cs')) {
      baseName = 'Tcheco';
      flag = '🇨🇿 ';
    } else if (lang.includes('hun') || lang.includes('hu')) {
      baseName = 'Húngaro';
      flag = '🇭🇺 ';
    } else if (lang.includes('rum') || lang.includes('ron') || lang.includes('ro')) {
      baseName = 'Romeno';
      flag = '🇷🇴 ';
    } else if (lang.includes('dan') || lang.includes('da')) {
      baseName = 'Dinamarquês';
      flag = '🇩🇰 ';
    } else if (lang.includes('nor') || lang.includes('no')) {
      baseName = 'Norueguês';
      flag = '🇳🇴 ';
    } else if (lang.includes('fin') || lang.includes('fi')) {
      baseName = 'Finlandês';
      flag = '🇫🇮 ';
    } else if (lang.includes('gre') || lang.includes('ell') || lang.includes('el')) {
      baseName = 'Grego';
      flag = '🇬🇷 ';
    } else if (lang.includes('heb') || lang.includes('he')) {
      baseName = 'Hebraico';
      flag = '🇮🇱 ';
    } else {
      baseName = rawTitle || (lang !== 'und' ? lang.toUpperCase() : `Legenda #${s.index}`);
      flag = '💬 ';
    }

    let tag = '';
    if (isCaptions) {
      tag = ' [SDH]';
    } else if (isForced) {
      tag = ' [Forced]';
    } else if (baseName && !baseName.startsWith('Legenda #')) {
      tag = ' [Completo]';
    }

    s.title = `${flag}${baseName}${tag}`;
  });

  // Parsing inteligente do título do arquivo / torrent via @viren070/parse-torrent-title
  const fallbackFilename = extractFilenameFromUrl(targetUrl);
  const rawFileTitle = mediaTitle || fallbackFilename;
  let cleanTitle = rawFileTitle;
  let parsedTorrent: any = null;

  if (rawFileTitle) {
    try {
      parsedTorrent = parseTorrentTitle(rawFileTitle);
      if (parsedTorrent?.title) {
        let formatted = parsedTorrent.title;
        if (parsedTorrent.seasons && parsedTorrent.seasons.length > 0) {
          const s = String(parsedTorrent.seasons[0]).padStart(2, '0');
          const e =
            parsedTorrent.episodes && parsedTorrent.episodes.length > 0
              ? String(parsedTorrent.episodes[0]).padStart(2, '0')
              : '';
          formatted += ` S${s}${e ? 'E' + e : ''}`;
        }
        if (parsedTorrent.episodeTitle) {
          formatted += ` - ${parsedTorrent.episodeTitle}`;
        }
        cleanTitle = formatted;
      }
    } catch (err) {
      console.warn('[ParseTorrentTitle] Falha ao processar título:', err);
    }
  }

  // Parse da Duração Total da Mídia: Duration: 00:23:45.67, start: ...
  let mediaDuration = 0;
  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/i);
  if (durationMatch) {
    const h = parseInt(durationMatch[1], 10);
    const m = parseInt(durationMatch[2], 10);
    const s = parseFloat(durationMatch[3]);
    mediaDuration = h * 3600 + m * 60 + s;
  }

  const result = {
    title: cleanTitle,
    rawTitle: rawFileTitle,
    parsedTorrent,
    duration: mediaDuration,
    audios,
    subtitles,
    chapters,
    fonts,
    video,
    streamUrl,
  };

  return result;
}
