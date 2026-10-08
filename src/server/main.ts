import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApiRouter } from './app';
import { startBackend } from './boot';
import { config } from './config';
import { sendApiError } from './http';

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

app.use(
  express.static(dist, {
    index: false,
    setHeaders(res, file) {
      // Arquivos com hash no nome (assets/) nunca mudam; o resto revalida
      res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  })
);
// SPA: qualquer outra rota GET abre o app
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(indexHtml);
});

const server = http.createServer(app);
startBackend(server);

server.listen(config.port, config.host, () => {
  console.log(`[Lunio] Servidor no ar em http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
});

const shutdown = (signal: string) => {
  console.log(`[Lunio] ${signal} recebido: encerrando…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
