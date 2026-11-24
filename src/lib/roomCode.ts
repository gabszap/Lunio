/**
 * Utilitários de Código e Validação de Salas de Watch Party (inspirado no juntos.lol)
 */

const ROOM_CODE_REGEX = /^[A-Z0-9]{4,32}$/;

// Caracteres alfanuméricos sem ambiguidade visual (exclui 0, O, 1, I)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Gera um código aleatório e exclusivo de 8 caracteres
 */
export function generateRoomCode(): string {
  let result = '';
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < 8; i++) {
      result += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
  } else {
    for (let i = 0; i < 8; i++) {
      result += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    }
  }
  return result;
}

/**
 * Extrai e normaliza o código de sala a partir de qualquer entrada:
 * - Código direto: "X7K9P2W1" -> "X7K9P2W1"
 * - URL com query param: "https://site.com/?room=X7K9P2W1" -> "X7K9P2W1"
 * - Path de sala: "site.com/room/X7K9P2W1" -> "X7K9P2W1"
 */
export function roomCodeFrom(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. Tenta extrair de parâmetros de query se for URL (ex: ?room=XYZ)
  try {
    if (trimmed.includes('?')) {
      const dummyOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
      const parsed = new URL(trimmed.startsWith('http') ? trimmed : `${dummyOrigin}/${trimmed.replace(/^\/+/, '')}`);
      const queryParam = parsed.searchParams.get('room');
      if (queryParam) {
        const candidate = queryParam.trim().toUpperCase();
        if (ROOM_CODE_REGEX.test(candidate)) return candidate;
      }
    }
  } catch {}

  // 2. Tenta extrair do último segmento do path (ex: juntos.lol/room/XYZ ou apenas XYZ)
  const withoutQuery = trimmed.split(/[?#]/)[0];
  const segments = withoutQuery.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  const candidate = last.toUpperCase();

  return ROOM_CODE_REGEX.test(candidate) ? candidate : null;
}

/**
 * Extrai o código da sala do endereço atual (`/room/CODE` ou o legado `?room=CODE`).
 */
export function readRoomFromUrl(href?: string): string | null {
  try {
    const raw = href ?? (typeof window !== 'undefined' ? window.location.href : '');
    if (!raw) return null;
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const url = new URL(raw, base);
    const pathMatch = /^\/room\/([A-Za-z0-9]{4,32})\/?$/i.exec(url.pathname);
    if (pathMatch) {
      const candidate = pathMatch[1].toUpperCase();
      if (ROOM_CODE_REGEX.test(candidate)) return candidate;
    }
    const queryRoom = url.searchParams.get('room');
    if (queryRoom) {
      const candidate = queryRoom.trim().toUpperCase();
      if (ROOM_CODE_REGEX.test(candidate)) return candidate;
    }
  } catch {}
  return null;
}

/**
 * Atualiza a URL do navegador para `/room/CODE` (ou limpa de volta para `/home` ao sair).
 */
export function setRoomInUrl(code: string | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  if (code) {
    url.pathname = `/room/${code}`;
  } else if (/^\/room\//i.test(url.pathname)) {
    url.pathname = '/home';
  }
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}

/**
 * Monta o link completo de compartilhamento para a sala (`/room/CODE`).
 */
export function formatRoomUrl(roomId: string): string {
  if (typeof window === 'undefined') return `/room/${roomId}`;
  return new URL(`/room/${roomId}`, window.location.origin).toString();
}
