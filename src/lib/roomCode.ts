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
 * Monta o link completo de compartilhamento para a sala
 */
export function formatRoomUrl(roomId: string): string {
  if (typeof window === 'undefined') return `?room=${roomId}`;
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  return url.toString();
}
