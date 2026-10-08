import type { Server as HttpServer } from 'node:http';
import { startCleanup } from './cleanup';
import { config } from './config';
import { setupWebSocketServer } from './roomServer';
import { logToolStatus } from './tools';

let started = false;

/**
 * Tudo o que sobe junto com o servidor HTTP, seja `main.ts` ou o plugin do Vite:
 * WebSocket das salas (/api/ws), aviso das ferramentas (FFmpeg/Python) e a limpeza periódica de disco.
 */
export function startBackend(httpServer: HttpServer | null) {
  if (httpServer) setupWebSocketServer(httpServer);
  if (started) return;
  started = true;

  if (config.allowPrivateUrls) {
    console.warn('[Segurança] ALLOW_PRIVATE_URLS ligado: o proxy aceita endereços de rede interna. Use só em desenvolvimento.');
  }
  if (config.sessionSecretIsEphemeral) {
    console.log('[Segurança] SESSION_SECRET não definido: os tokens de sessão valem só até o servidor reiniciar.');
  }
  logToolStatus();
  startCleanup();
}
