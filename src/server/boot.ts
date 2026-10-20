import type { Server as HttpServer } from 'node:http';
import { startCleanup } from './cleanup';
import { config } from './config';
import { installLogRedaction } from './logRedaction';
import { roomManager, setupWebSocketServer } from './roomServer';
import { logToolStatus } from './tools';

let started = false;
let restoring: Promise<void> | null = null;

/** Restaura as salas gravadas no Redis (uma vez). Falha nunca derruba a subida: o servidor segue com as salas vazias. */
export function ensureRoomsRestored(): Promise<void> {
  if (!restoring) {
    restoring = roomManager
      .restore()
      .then(() => undefined)
      .catch((err) => console.warn('[WatchParty] Falha ao restaurar as salas:', (err as Error)?.message));
  }
  return restoring;
}

/**
 * Tudo o que sobe junto com o servidor HTTP, seja `main.ts` ou o plugin do Vite:
 * WebSocket das salas (/api/ws), aviso das ferramentas (FFmpeg/Python) e a limpeza periódica de disco.
 */
export function startBackend(httpServer: HttpServer | null) {
  if (httpServer) setupWebSocketServer(httpServer);
  if (started) return;
  started = true;
  // Token do TorBox na URL do stderr do FFmpeg ia parar no journal
  installLogRedaction();

  if (config.allowPrivateUrls) {
    console.warn('[Segurança] ALLOW_PRIVATE_URLS ligado: o proxy aceita endereços de rede interna. Use só em desenvolvimento.');
  }
  if (config.sessionSecretIsEphemeral) {
    console.log('[Segurança] SESSION_SECRET não definido: os tokens de sessão valem só até o servidor reiniciar.');
  }
  logToolStatus();
  startCleanup();
  void ensureRoomsRestored();
}
