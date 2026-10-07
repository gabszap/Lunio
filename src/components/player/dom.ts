import type { RefObject } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';

/** O <video> real do Vidstack (ou o primeiro da página, se o player ainda não montou). */
export function getVideoElement(playerRef: RefObject<MediaPlayerInstance | null>): HTMLVideoElement | null {
  return (
    playerRef.current?.el?.querySelector('video') ||
    (document.querySelector('video') as HTMLVideoElement | null)
  );
}
