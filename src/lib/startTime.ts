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

/** O `?t=` do endereço atual, em segundos (ou null). */
export function readStartTime(): number | null {
  if (typeof window === 'undefined') return null;
  return parseStartTime(new URLSearchParams(window.location.search).get('t'));
}

/** Tira o `?t=` do endereço: depois de usado, recarregar a página ou copiar o link da sala não o leva de volta àquele ponto. */
export function clearStartTime() {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has('t')) return;
  url.searchParams.delete('t');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}
