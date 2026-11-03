export interface ScreenCapabilities {
  /** Pode transmitir a tela: só Chromium de desktop (captura com áudio do sistema, codificadores e WebTransport). */
  host: boolean;
  /** Pode assistir: precisa de WebTransport, dos decodificadores e de AudioContext (Chromium e Firefox; Safari/iOS ficam de fora). */
  viewer: boolean;
  /** Por que não pode (para a interface explicar), quando alguma das duas é falsa. */
  reason?: string;
}

const has = (name: string) => typeof (globalThis as Record<string, unknown>)[name] !== 'undefined';

export function screenCapabilities(): ScreenCapabilities {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const mobile = /Mobi|Android|iPhone|iPad/i.test(ua);
  const chromium = /Chrome|Chromium|Edg\//.test(ua);

  if (!has('WebTransport')) return { host: false, viewer: false, reason: 'O navegador não tem WebTransport.' };

  const viewer = has('VideoDecoder') && has('AudioDecoder') && has('AudioContext');
  if (!viewer) return { host: false, viewer: false, reason: 'O navegador não decodifica vídeo e áudio.' };

  const canCapture =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    has('MediaStreamTrackProcessor') &&
    has('VideoEncoder') &&
    has('AudioEncoder');

  if (mobile) return { host: false, viewer: true, reason: 'Só dá para transmitir a tela pelo computador.' };
  if (!chromium || !canCapture) return { host: false, viewer: true, reason: 'Para transmitir a tela use o Chrome, o Edge ou o Brave no computador.' };
  return { host: true, viewer: true };
}
