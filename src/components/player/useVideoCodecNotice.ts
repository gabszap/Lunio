import { useEffect, useState, type RefObject } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import type { VideoInfo } from '../../types/media';
import { logger } from '../../lib/logger';
import { t } from '../../lib/i18n';
import { checkVideoSupport } from '../../lib/videoSupport';
import { getVideoElement } from './dom';

export interface CodecNotice {
  title: string;
  text: string;
}

/** Quanto tempo, depois de abrir um vídeo, o player fica de olho em "carregou mas sem imagem". */
const WATCH_MS = 30_000;

/**
 * Avisa quando este navegador não vai mostrar a imagem do vídeo (HEVC sem decodificação, H.264 de 10 bits…):
 * nesses casos o áudio toca, a tela fica vazia e não há erro. Dois caminhos:
 *  1. pelas faixas lidas no servidor: pergunta ao navegador se decodifica aquele codec;
 *  2. em execução: o `<video>` já tem dados, mas `videoWidth` continua 0 (pega o que o item 1 não previu).
 */
export function useVideoCodecNotice(args: {
  playerRef: RefObject<MediaPlayerInstance | null>;
  videoInfo: VideoInfo | null;
  resolvedStreamUrl: string;
}) {
  const { playerRef, videoInfo, resolvedStreamUrl } = args;
  const [notice, setNotice] = useState<CodecNotice | null>(null);

  // 1) Pelas faixas
  useEffect(() => {
    setNotice(null);
    if (!videoInfo) return;
    let cancelled = false;
    void checkVideoSupport(videoInfo).then((support) => {
      const details = [videoInfo.profile, videoInfo.width && `${videoInfo.width}x${videoInfo.height}`].filter(Boolean).join(' · ');
      logger.info(`[Mídia] Vídeo: ${support.label}${details ? ` (${details})` : ''}`);
      if (cancelled || support.supported !== false) return;
      logger.warn(`[Mídia] Este navegador não decodifica ${support.label}: o som toca, mas a imagem pode não aparecer`);
      setNotice({
        title: t('Este vídeo pode não aparecer'),
        text: t('Seu navegador não decodifica {codec}. O som toca, mas a imagem pode ficar vazia. Tente outro navegador ou uma versão do arquivo em H.264.', {
          codec: support.label,
        }),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [videoInfo]);

  // 2) Em execução: tem dados mas nenhuma imagem
  useEffect(() => {
    if (!resolvedStreamUrl || resolvedStreamUrl.startsWith('youtube/')) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const el = getVideoElement(playerRef);
      if (el && el.readyState >= 2 && el.videoWidth > 0) return clearInterval(timer); // a imagem existe: nada a avisar
      if (el && el.readyState >= 2 && el.duration > 0 && el.videoWidth === 0) {
        clearInterval(timer);
        logger.warn('[Player] O vídeo carregou, mas o navegador não decodificou a imagem (0×0)');
        setNotice((prev) =>
          prev ?? {
            title: t('Este vídeo pode não aparecer'),
            text: t('O vídeo carregou, mas o navegador não mostra a imagem. Isso é comum com HEVC (H.265) e vídeos de 10 bits. Tente outro navegador ou uma versão do arquivo em H.264.'),
          }
        );
      } else if (Date.now() - startedAt > WATCH_MS) {
        clearInterval(timer);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [resolvedStreamUrl]);

  return { notice, dismiss: () => setNotice(null) };
}
