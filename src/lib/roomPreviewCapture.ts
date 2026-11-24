import { apiFetch } from './access';

export const PREVIEW_MAX_BYTES = 65_536;
export const PREVIEW_MAX_WIDTH = 480;
export const PREVIEW_MAX_HEIGHT = 270;

const PRIMARY_QUALITY = 0.72;
const FALLBACK_QUALITY = 0.48;

export type PreviewMimeType = 'image/jpeg' | 'image/webp';

/**
 * Calcula dimensões proporcionais dentro do teto informado sem fazer upscale.
 * Retorna `{ width: 0, height: 0 }` para entradas inválidas.
 */
export function fitDimensions(
  srcW: number,
  srcH: number,
  maxW = PREVIEW_MAX_WIDTH,
  maxH = PREVIEW_MAX_HEIGHT
): { width: number; height: number } {
  if (
    !Number.isFinite(srcW) ||
    !Number.isFinite(srcH) ||
    !Number.isFinite(maxW) ||
    !Number.isFinite(maxH) ||
    srcW <= 0 ||
    srcH <= 0 ||
    maxW <= 0 ||
    maxH <= 0
  ) {
    return { width: 0, height: 0 };
  }

  const scale = Math.min(1, maxW / srcW, maxH / srcH);
  const ceilW = Math.max(1, Math.floor(maxW));
  const ceilH = Math.max(1, Math.floor(maxH));
  const width = Math.min(ceilW, Math.max(1, Math.round(srcW * scale)));
  const height = Math.min(ceilH, Math.max(1, Math.round(srcH * scale)));
  return { width, height };
}

function encodeCanvas(
  canvas: HTMLCanvasElement,
  mimeType: PreviewMimeType,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob || blob.size === 0) {
          resolve(null);
          return;
        }
        // Navegadores sem encoder WebP fazem fallback silencioso para image/png.
        if (blob.type && blob.type !== mimeType) {
          resolve(null);
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality
    );
  });
}

/**
 * Captura um frame redimensionado do `<video>` em WebP (fallback JPEG) respeitando o teto de 64 KB.
 * Silencia `SecurityError` (vídeo cross-origin/canvas tainted) e qualquer erro de canvas retornando `null`.
 */
export async function captureVideoFrame(
  video: HTMLVideoElement,
  maxW = PREVIEW_MAX_WIDTH,
  maxH = PREVIEW_MAX_HEIGHT
): Promise<{ blob: Blob; mimeType: 'image/jpeg' | 'image/webp' } | null> {
  if (!video || typeof document === 'undefined') return null;
  if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return null;

  const { width, height } = fitDimensions(video.videoWidth, video.videoHeight, maxW, maxH);
  if (width <= 0 || height <= 0) return null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, width, height);

    let mimeType: PreviewMimeType = 'image/webp';
    let blob = await encodeCanvas(canvas, 'image/webp', PRIMARY_QUALITY);
    if (!blob) {
      mimeType = 'image/jpeg';
      blob = await encodeCanvas(canvas, 'image/jpeg', PRIMARY_QUALITY);
    }
    if (!blob) return null;

    if (blob.size <= PREVIEW_MAX_BYTES) {
      return { blob, mimeType };
    }

    const smaller = await encodeCanvas(canvas, mimeType, FALLBACK_QUALITY);
    if (smaller && smaller.size <= PREVIEW_MAX_BYTES) {
      return { blob: smaller, mimeType };
    }

    return null;
  } catch {
    return null;
  }
}

/** Envia o snapshot da sala pública atual para o servidor. Silencia falhas de rede/abort. */
export async function uploadRoomPreview(
  blob: Blob,
  mimeType: 'image/jpeg' | 'image/webp',
  signal?: AbortSignal
): Promise<boolean> {
  if (!blob || blob.size === 0 || blob.size > PREVIEW_MAX_BYTES) return false;
  try {
    const res = await apiFetch('/api/roompreview', {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: blob,
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Remove o snapshot em memória da sala atual no servidor. */
export async function clearRoomPreviewOnServer(): Promise<void> {
  try {
    await apiFetch('/api/roompreview', { method: 'DELETE' }).catch(() => {});
  } catch {
    // silencia qualquer falha síncrona/rede
  }
}
