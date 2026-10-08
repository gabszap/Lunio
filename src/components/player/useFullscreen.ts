import { useEffect, useState, type RefObject } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';
import { logger } from '../../lib/logger';
import { subtitleManager } from '../../lib/subtitles';

/** Tela cheia (nativa ou "ocupar a janela" no iframe do Discord), Picture-in-Picture e redimensionamento da legenda ASS. */
export function useFullscreen(playerRef: RefObject<MediaPlayerInstance | null>, containerRef: RefObject<HTMLDivElement | null>) {
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isPip, setIsPip] = useState<boolean>(false);

  const triggerFullscreenVisuals = (active: boolean) => {
    setIsFullscreen(active);
    logger.action(active ? '[Player] Tela cheia' : '[Player] Saiu da tela cheia');

    if (active) {
      document.documentElement.classList.add('is-fullscreen');
      document.body.classList.add('is-fullscreen');
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
    } else {
      document.documentElement.classList.remove('is-fullscreen');
      document.body.classList.remove('is-fullscreen');
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    }

    // Avisa o Vidstack sobre a mudança de fullscreen para que o CSS interno (media-outlet) se ajuste
    if (playerRef.current?.el) {
      if (active) {
        playerRef.current.el.setAttribute('data-fullscreen', '');
      } else {
        playerRef.current.el.removeAttribute('data-fullscreen');
      }
    }

    // Dispara evento de redimensionamento para sincronizar layout e canvas
    window.dispatchEvent(new Event('resize'));

    // Re-alinha canvas do LibASS para prevenir qualquer sobreposição escura em tela cheia
    setTimeout(() => {
      subtitleManager.resize();
    }, 50);
    setTimeout(() => {
      subtitleManager.resize();
    }, 150);
    setTimeout(() => {
      subtitleManager.resize();
    }, 350);
  };

  const handleFullscreenToggle = () => {
    if (!containerRef.current) return;

    // Se já estiver em fullscreen (seja nativo ou modo janela / iframe)
    if (isFullscreen) {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch((err) => {
          logger.warn('[Player] Falha ao sair da tela cheia:', err);
          triggerFullscreenVisuals(false);
        });
      } else {
        triggerFullscreenVisuals(false);
      }
      return;
    }

    // Se não estiver em fullscreen, tenta nativo com fallback transparente para iframe do Discord
    if (typeof containerRef.current.requestFullscreen === 'function') {
      containerRef.current.requestFullscreen().catch(() => {
        logger.info('[Player] O Discord não permite tela cheia nativa; ocupando a janela inteira');
        triggerFullscreenVisuals(true);
      });
    } else {
      triggerFullscreenVisuals(true);
    }
  };

  const handlePipToggle = async () => {
    const videoEl = playerRef.current?.el?.querySelector('video');
    if (!videoEl) return;

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPip(false);
        logger.action('[Player] Picture-in-Picture desligado');
      } else if (typeof videoEl.requestPictureInPicture === 'function') {
        await videoEl.requestPictureInPicture();
        setIsPip(true);
        logger.action('[Player] Picture-in-Picture ligado');
      }
    } catch (err) {
      logger.warn('[Player] Erro no Picture-in-Picture:', err);
    }
  };

  // Fullscreen change listener
  useEffect(() => {
    const handleFsChange = () => {
      const isFs = !!document.fullscreenElement;
      triggerFullscreenVisuals(isFs);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.documentElement.classList.remove('is-fullscreen');
      document.body.classList.remove('is-fullscreen');
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    };
  }, []);

  // ResizeObserver e window resize listener para recalcular dimensões do canvas de legendas (JASSUB) no Split Screen
  useEffect(() => {
    const handleResize = () => {
      subtitleManager.resize();
    };
    window.addEventListener('resize', handleResize);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      resizeObserver = new ResizeObserver(() => {
        subtitleManager.resize();
      });
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    };
  }, []);

  return { isFullscreen, isPip, triggerFullscreenVisuals, handleFullscreenToggle, handlePipToggle };
}
