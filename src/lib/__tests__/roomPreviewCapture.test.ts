import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_MAX_BYTES,
  PREVIEW_MAX_HEIGHT,
  PREVIEW_MAX_WIDTH,
  captureVideoFrame,
  clearRoomPreviewOnServer,
  fitDimensions,
  uploadRoomPreview,
} from '../roomPreviewCapture';

interface MockCanvasOptions {
  drawImage?: (video: unknown, x: number, y: number, w: number, h: number) => void;
  toBlob: (cb: BlobCallback, type?: string, quality?: number) => void;
}

function stubDocumentCanvas(opts: MockCanvasOptions) {
  const drawImage = vi.fn(opts.drawImage ?? (() => {}));
  const toBlob = vi.fn(opts.toBlob);
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    toBlob,
  };
  vi.stubGlobal('document', {
    createElement: vi.fn((tag: string) => {
      if (tag === 'canvas') return canvas;
      throw new Error(`Unexpected tag: ${tag}`);
    }),
  });
  return { canvas, drawImage, toBlob };
}

function makeVideo(overrides: Partial<Pick<HTMLVideoElement, 'readyState' | 'videoWidth' | 'videoHeight'>> = {}) {
  return {
    readyState: 4,
    videoWidth: 1920,
    videoHeight: 1080,
    ...overrides,
  } as HTMLVideoElement;
}

function makeBlobOfSize(bytes: number, type: string): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fitDimensions', () => {
  it('preserva proporção 16:9 dentro do teto padrão 480x270', () => {
    expect(PREVIEW_MAX_WIDTH).toBe(480);
    expect(PREVIEW_MAX_HEIGHT).toBe(270);
    expect(PREVIEW_MAX_BYTES).toBe(65_536);

    expect(fitDimensions(1920, 1080)).toEqual({ width: 480, height: 270 });
    expect(fitDimensions(1280, 720)).toEqual({ width: 480, height: 270 });
  });

  it('preserva proporção vertical 9:16 respeitando a altura máxima', () => {
    expect(fitDimensions(1080, 1920)).toEqual({ width: 152, height: 270 });
  });

  it('não faz upscale quando a imagem é menor que o teto', () => {
    expect(fitDimensions(320, 180)).toEqual({ width: 320, height: 180 });
    expect(fitDimensions(200, 200)).toEqual({ width: 200, height: 200 });
  });

  it('respeita limites customizados', () => {
    expect(fitDimensions(1920, 1080, 240, 240)).toEqual({ width: 240, height: 135 });
  });

  it('retorna zeros para entradas inválidas', () => {
    expect(fitDimensions(0, 1080)).toEqual({ width: 0, height: 0 });
    expect(fitDimensions(1920, 0)).toEqual({ width: 0, height: 0 });
    expect(fitDimensions(-100, 100)).toEqual({ width: 0, height: 0 });
    expect(fitDimensions(Number.NaN, 100)).toEqual({ width: 0, height: 0 });
    expect(fitDimensions(1920, Number.POSITIVE_INFINITY)).toEqual({ width: 0, height: 0 });
    expect(fitDimensions(1920, 1080, 0, 270)).toEqual({ width: 0, height: 0 });
  });
});

describe('captureVideoFrame', () => {
  it('retorna null quando readyState < 2 ou dimensões de vídeo são zero', async () => {
    const createElement = vi.fn();
    vi.stubGlobal('document', { createElement });

    expect(await captureVideoFrame(makeVideo({ readyState: 0 }))).toBeNull();
    expect(await captureVideoFrame(makeVideo({ readyState: 1 }))).toBeNull();
    expect(await captureVideoFrame(makeVideo({ videoWidth: 0, videoHeight: 1080 }))).toBeNull();
    expect(await captureVideoFrame(makeVideo({ videoWidth: 1920, videoHeight: 0 }))).toBeNull();
    expect(createElement).not.toHaveBeenCalled();
  });

  it('captura SecurityError (canvas tainted) silenciosamente e retorna null', async () => {
    const securityErr = new DOMException('Tainted canvas', 'SecurityError');
    stubDocumentCanvas({
      toBlob: () => {
        throw securityErr;
      },
    });

    await expect(captureVideoFrame(makeVideo())).resolves.toBeNull();
  });

  it('silencia SecurityError lançado no drawImage e retorna null', async () => {
    const securityErr = new DOMException('Blocked cross-origin frame', 'SecurityError');
    stubDocumentCanvas({
      drawImage: () => {
        throw securityErr;
      },
      toBlob: (cb) => cb(makeBlobOfSize(1024, 'image/webp')),
    });

    await expect(captureVideoFrame(makeVideo())).resolves.toBeNull();
  });

  it('gera WebP com qualidade 0.72 redimensionado via fitDimensions', async () => {
    const { canvas, drawImage, toBlob } = stubDocumentCanvas({
      toBlob: (cb, type) => {
        cb(makeBlobOfSize(12_000, type ?? 'image/webp'));
      },
    });

    const video = makeVideo({ videoWidth: 1920, videoHeight: 1080 });
    const result = await captureVideoFrame(video);

    expect(canvas.width).toBe(480);
    expect(canvas.height).toBe(270);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 480, 270);
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(toBlob.mock.calls[0][1]).toBe('image/webp');
    expect(toBlob.mock.calls[0][2]).toBe(0.72);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('image/webp');
    expect(result?.blob.size).toBe(12_000);
  });

  it('faz fallback para image/jpeg 0.72 quando WebP não é suportado', async () => {
    const { toBlob } = stubDocumentCanvas({
      toBlob: (cb, type) => {
        if (type === 'image/webp') {
          // Navegadores sem suporte a WebP devolvem PNG ou null
          cb(makeBlobOfSize(8_000, 'image/png'));
          return;
        }
        cb(makeBlobOfSize(10_000, 'image/jpeg'));
      },
    });

    const result = await captureVideoFrame(makeVideo());

    expect(toBlob).toHaveBeenCalledTimes(2);
    expect(toBlob.mock.calls[0][1]).toBe('image/webp');
    expect(toBlob.mock.calls[1][1]).toBe('image/jpeg');
    expect(toBlob.mock.calls[1][2]).toBe(0.72);
    expect(result?.mimeType).toBe('image/jpeg');
    expect(result?.blob.size).toBe(10_000);
  });

  it('tenta qualidade menor (0.48) quando o primeiro blob excede 65_536 bytes', async () => {
    const { toBlob } = stubDocumentCanvas({
      toBlob: (cb, type, quality) => {
        const size = quality === 0.72 ? PREVIEW_MAX_BYTES + 4_000 : 40_000;
        cb(makeBlobOfSize(size, type ?? 'image/webp'));
      },
    });

    const result = await captureVideoFrame(makeVideo());

    expect(toBlob).toHaveBeenCalledTimes(2);
    expect(toBlob.mock.calls[0][1]).toBe('image/webp');
    expect(toBlob.mock.calls[0][2]).toBe(0.72);
    expect(toBlob.mock.calls[1][1]).toBe('image/webp');
    expect(toBlob.mock.calls[1][2]).toBe(0.48);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('image/webp');
    expect(result?.blob.size).toBe(40_000);
  });

  it('descarta (retorna null) se o blob ainda exceder 65_536 bytes na qualidade menor', async () => {
    const { toBlob } = stubDocumentCanvas({
      toBlob: (cb, type) => {
        cb(makeBlobOfSize(PREVIEW_MAX_BYTES + 1, type ?? 'image/webp'));
      },
    });

    const result = await captureVideoFrame(makeVideo());

    expect(toBlob).toHaveBeenCalledTimes(2);
    expect(toBlob.mock.calls[0][2]).toBe(0.72);
    expect(toBlob.mock.calls[1][2]).toBe(0.48);
    expect(result).toBeNull();
  });
});

describe('uploadRoomPreview e clearRoomPreviewOnServer', () => {
  it('envia PUT /api/roompreview com Content-Type e retorna true em resposta ok', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === '/api/session') {
        return new Response(JSON.stringify({ token: 'tok' }), { status: 200 });
      }
      return new Response(JSON.stringify({ version: 1 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const blob = makeBlobOfSize(1024, 'image/webp');
    const ok = await uploadRoomPreview(blob, 'image/webp');

    expect(ok).toBe(true);
    const putCall = fetchMock.mock.calls.find(([u]) => u === '/api/roompreview');
    expect(putCall).toBeDefined();
    const init = putCall![1];
    expect(init).toBeDefined();
    expect(init!.method).toBe('PUT');
    expect(new Headers(init!.headers).get('Content-Type')).toBe('image/webp');
    expect(init!.body).toBe(blob);
  });

  it('envia DELETE /api/roompreview em clearRoomPreviewOnServer', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === '/api/session') {
        return new Response(JSON.stringify({ token: 'tok' }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await clearRoomPreviewOnServer();

    const delCall = fetchMock.mock.calls.find(([u]) => u === '/api/roompreview');
    expect(delCall).toBeDefined();
    expect(delCall![1]?.method).toBe('DELETE');
  });

  it('não envia e retorna false quando o blob excede PREVIEW_MAX_BYTES', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const oversized = makeBlobOfSize(PREVIEW_MAX_BYTES + 1, 'image/jpeg');
    expect(await uploadRoomPreview(oversized, 'image/jpeg')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('silencia erros de rede em uploadRoomPreview e clearRoomPreviewOnServer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );

    const blob = makeBlobOfSize(512, 'image/jpeg');
    await expect(uploadRoomPreview(blob, 'image/jpeg')).resolves.toBe(false);
    await expect(clearRoomPreviewOnServer()).resolves.toBeUndefined();
  });
});
