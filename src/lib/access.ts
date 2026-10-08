import { useSyncExternalStore } from 'react';

/**
 * Token de sessão para a API do servidor (/api/proxy, /api/tracks, /api/subtitle, /api/font, /api/upload…).
 *
 *  - Sala: o servidor entrega um token ao entrar (WebSocket); só o token de um Host de sala ativa envia arquivos.
 *  - Solo: `POST /api/session` entrega um token próprio (vale 12 h).
 *
 * Os dois abrem a API de mídia. Quem monta uma URL para `<video src>` ou para o JASSUB (que não mandam
 * cabeçalhos) usa `withAccess`; `fetch` usa `apiFetch`.
 */

let soloToken = '';
let soloPromise: Promise<void> | null = null;
let roomToken = '';
let roomTokenRoomId = '';
const listeners = new Set<() => void>();
const roomWaiters = new Set<(roomId: string, token: string) => void>();

function emit() {
  for (const l of listeners) l();
}

/** Há algum token disponível? Muda uma vez (false → true); trocar solo por sala não conta. */
export function useAccessReady(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => Boolean(soloToken || roomToken),
    () => false
  );
}

export function getAccessToken(): string {
  return roomToken || soloToken;
}

/** Chamado pelo `syncManager` quando o servidor entrega (ou renova) o token da sala. */
export function setRoomToken(roomId: string, token: string) {
  const hadAny = Boolean(soloToken || roomToken);
  roomToken = token;
  roomTokenRoomId = roomId;
  for (const w of roomWaiters) w(roomId, token);
  if (!hadAny) emit();
}

export function clearRoomToken() {
  roomToken = '';
  roomTokenRoomId = '';
}

/** Espera o token de Host/membro da sala `roomId` (a entrada pelo WebSocket é assíncrona). */
export function waitForRoomToken(roomId: string, timeoutMs = 8000): Promise<string> {
  if (roomToken && roomTokenRoomId === roomId) return Promise.resolve(roomToken);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      roomWaiters.delete(waiter);
      reject(new Error('timeout'));
    }, timeoutMs);
    const waiter = (id: string, token: string) => {
      if (id !== roomId) return;
      clearTimeout(timer);
      roomWaiters.delete(waiter);
      resolve(token);
    };
    roomWaiters.add(waiter);
  });
}

async function fetchSoloToken(): Promise<void> {
  const res = await fetch('/api/session', { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const hadAny = Boolean(soloToken || roomToken);
  soloToken = String(body.token || '');
  if (!hadAny && soloToken) emit();
}

/** Garante um token de sessão. Barato se já houver um; deduplica chamadas simultâneas. */
export function ensureSession(force = false): Promise<void> {
  if (!force && (soloToken || roomToken)) return Promise.resolve();
  if (!soloPromise) {
    soloPromise = fetchSoloToken().finally(() => {
      soloPromise = null;
    });
  }
  return soloPromise;
}

/** Anexa `t=<token>` a uma URL da nossa API (antes do `#…`). URLs externas passam intactas. */
export function withAccess(url: string): string {
  if (!url.startsWith('/api/')) return url;
  const token = getAccessToken();
  if (!token) return url;
  const hash = url.indexOf('#');
  const base = hash < 0 ? url : url.slice(0, hash);
  const fragment = hash < 0 ? '' : url.slice(hash);
  if (/[?&]t=/.test(base)) return url;
  return `${base}${base.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}${fragment}`;
}

/** `fetch` para a nossa API: manda o token em cabeçalho e, se o servidor recusar (reiniciou), renova uma vez. */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!url.startsWith('/api/')) return fetch(url, init);
  try {
    await ensureSession();
  } catch {
    // sem token o servidor responde 401 e o chamador trata
  }
  const send = (token: string) => {
    const headers = new Headers(init.headers);
    if (token) headers.set('X-Lunio-Token', token);
    return fetch(url, { ...init, headers });
  };
  const res = await send(getAccessToken());
  if (res.status !== 401) return res;
  try {
    await ensureSession(true);
  } catch {
    return res;
  }
  return send(soloToken);
}
