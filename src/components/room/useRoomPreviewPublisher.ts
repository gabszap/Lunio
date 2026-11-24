import { useEffect, useRef } from 'react';
import type { RoomVisibility } from '../../types/sync';
import {
  captureVideoFrame,
  clearRoomPreviewOnServer,
  uploadRoomPreview,
} from '../../lib/roomPreviewCapture';

const INITIAL_CAPTURE_DELAY_MS = 2_000;
const CAPTURE_INTERVAL_MS = 15_000;

export interface RoomPreviewPublisherOptions {
  connected: boolean;
  isHost: boolean;
  roomCode: string;
  visibility?: RoomVisibility;
  locked?: boolean;
  hasSource: boolean;
  screenStream: MediaStream | null;
}

/**
 * Captura periodicamente snapshots do vídeo ou transmissão de tela no navegador do Host
 * quando a sala está pública e destrancada, enviando para `/api/roompreview`.
 */
export function useRoomPreviewPublisher({
  connected,
  isHost,
  roomCode,
  visibility,
  locked,
  hasSource,
  screenStream,
}: RoomPreviewPublisherOptions): void {
  const active = Boolean(
    connected &&
      isHost &&
      roomCode &&
      visibility === 'public' &&
      !locked &&
      (Boolean(screenStream) || hasSource)
  );

  const prevRef = useRef<{ active: boolean; roomCode: string }>({
    active: false,
    roomCode: '',
  });

  useEffect(() => {
    const prev = prevRef.current;
    if (prev.active && !active && connected && isHost && roomCode && prev.roomCode === roomCode) {
      void clearRoomPreviewOnServer();
    }
    prevRef.current = { active, roomCode };
  }, [active, connected, isHost, roomCode]);

  useEffect(() => {
    if (!active || typeof document === 'undefined' || typeof window === 'undefined') return;

    let cancelled = false;
    let inFlight = false;
    let activeAbort: AbortController | null = null;
    let intervalId: number | null = null;
    let offscreenVideo: HTMLVideoElement | null = null;

    if (screenStream) {
      offscreenVideo = document.createElement('video');
      offscreenVideo.muted = true;
      offscreenVideo.playsInline = true;
      offscreenVideo.srcObject = screenStream;
      void offscreenVideo.play().catch(() => {});
    }

    const captureAndUpload = async () => {
      if (cancelled || inFlight || document.hidden) return;
      const video =
        offscreenVideo ?? document.querySelector<HTMLVideoElement>('#video-player-root video');
      if (!video) return;

      inFlight = true;
      const controller = new AbortController();
      activeAbort = controller;
      try {
        const frame = await captureVideoFrame(video);
        if (cancelled || !frame) return;
        await uploadRoomPreview(frame.blob, frame.mimeType, controller.signal);
      } finally {
        if (activeAbort === controller) activeAbort = null;
        inFlight = false;
      }
    };

    const initialTimer = window.setTimeout(() => {
      void captureAndUpload();
      if (!cancelled) {
        intervalId = window.setInterval(() => {
          void captureAndUpload();
        }, CAPTURE_INTERVAL_MS);
      }
    }, INITIAL_CAPTURE_DELAY_MS);

    const onVisibilityChange = () => {
      if (!document.hidden) {
        void captureAndUpload();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      if (intervalId !== null) window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      activeAbort?.abort();
      activeAbort = null;
      if (offscreenVideo) {
        try {
          offscreenVideo.pause();
        } catch {}
        offscreenVideo.srcObject = null;
        offscreenVideo = null;
      }
    };
  }, [active, roomCode, screenStream, hasSource]);
}
