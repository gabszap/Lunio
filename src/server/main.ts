import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApiRouter } from './app';
import { ensureRoomsRestored, startBackend } from './boot';
import { config } from './config';
import { sendApiError } from './http';
import { roomManager } from './roomServer';
import { mountStatic } from './static';

/**
 * Entrada de produção: Express servindo `dist/` + API + WebSocket, sem depender do Vite.
 *   npm run build && npm run serve
 * Editar o código das rotas não reinicia nada aqui (não há watcher): as salas só caem num deploy/restart.
 */

const dist = path.join(config.rootDir, 'dist');
const indexHtml = path.join(dist, 'index.html');
if (!fs.existsSync(indexHtml)) {
  console.error(`[Lunio] "${indexHtml}" não existe. Rode "npm run build" antes (ou use "npm start", que faz os dois).`);
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');

app.use(createApiRouter());
// Rota /api/* que nenhum handler atendeu: JSON, não o index.html do SPA
app.use('/api', (_req, res) => sendApiError(res, 404, 'not_found'));

mountStatic(app, dist);

const server = http.createServer(app);
startBackend(server);

// Só abre a porta depois de restaurar as salas do Redis (no máximo ~5 s, e só se o Redis estiver fora): quem reconecta
// logo depois do restart já encontra a sala, com o Host, os banidos e a fila de antes
void ensureRoomsRestored().then(() => {
  server.listen(config.port, config.host, () => {
    console.log(`[Lunio] Servidor no ar em http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  });
});

const shutdown = async (signal: string) => {
  console.log(`[Lunio] ${signal} recebido: encerrando…`);
  // Grava o estado mais novo das salas antes de sair (a posição, a fila e o Host de agora), com teto de 1,5 s
  await Promise.race([roomManager.flushPersistence(), new Promise((resolve) => setTimeout(resolve, 1500))]).catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
