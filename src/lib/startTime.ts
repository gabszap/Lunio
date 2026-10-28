/**
 * `?t=` no link da página: instante em que o vídeo abre, como no YouTube. Aceita segundos (`90`, `90s`), `1m30s`,
 * `1h2m3s` e relógio (`1:30`, `1:02:03`). Só vale para quem tem o controle (Host ou quem assiste sozinho); espectador
 * segue a posição da sala. Não confundir com o `?t=` das rotas `/api/*`, que é o token de sessão.
 */

const MAX_SECONDS = 48 * 3600;

export function parseStartTime(raw: string | null | undefined): number | null {
  const text = (raw ?? '').trim().toLowerCase();
  if (!text) return null;

  let seconds: number | null = null;
  if (/^\d+(\.\d+)?s?$/.test(text)) {
    seconds = parseFloat(text);
  } else if (/^\d+:\d{1,2}(:\d{1,2})?(\.\d+)?$/.test(text)) {
    const parts = text.split(':').map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return null;
    seconds = parts.reduce((total, part) => total * 60 + part, 0);
  } else {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text);
    if (m && (m[1] || m[2] || m[3])) seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  }

  if (seconds === null || !Number.isFinite(seconds) || seconds < 0 || seconds > MAX_SECONDS) return null;
  return seconds;
}

/** Instante pedido por dentro do app ("continuar assistindo"): vale como o `?t=`, uma vez, e perde a validade se o vídeo não abrir logo. */
const PENDING_TTL_MS = 2 * 60 * 1000;
let pending: { seconds: number; at: number } | null = null;

export function setPendingStart(seconds: number | null, now = Date.now()) {
  pending = seconds !== null && Number.isFinite(seconds) && seconds > 0 ? { seconds, at: now } : null;
}

/** Há um instante pedido pelo app esperando o vídeo abrir? */
export function hasPendingStart(now = Date.now()): boolean {
  return pending !== null && now - pending.at < PENDING_TTL_MS;
}

/** O `?t=` do endereço atual ou, sem ele, o instante pedido pelo app, em segundos (ou null). */
export function readStartTime(now = Date.now()): number | null {
  if (typeof window !== 'undefined') {
    const fromUrl = parseStartTime(new URLSearchParams(window.location.search).get('t'));
    if (fromUrl !== null) return fromUrl;
  }
  return hasPendingStart(now) ? pending!.seconds : null;
}

/** Tira o `?t=` do endereço: depois de usado, recarregar a página ou copiar o link da sala não o leva de volta àquele ponto. */
export function clearStartTime() {
  pending = null;
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has('t')) return;
  url.searchParams.delete('t');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}
