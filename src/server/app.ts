import { Router } from 'express';
import { apiGate } from './gate';
import { handleDrive } from './routes/drive';
import { handleFont } from './routes/font';
import { handleHls } from './routes/hls';
import { handleProxy } from './routes/proxy';
import { handleResolve } from './routes/resolve';
import { handleRoomInfo } from './routes/room';
import { handleSession } from './routes/session';
import { handleStatus } from './routes/status';
import { handleSubtitle } from './routes/subtitle';
import { handleToken } from './routes/token';
import { handleTracks } from './routes/tracks';
import { handleUpload, handleUploadServe } from './routes/upload';

/**
 * Todas as rotas da API num único Router do Express. Quem hospeda decide como plugá-lo:
 *  - `main.ts` (produção): Express servindo `dist/` + este router + WebSocket;
 *  - plugin do Vite (`npm run dev` / `npm run preview`): `server.middlewares.use(createApiRouter())`.
 */
export function createApiRouter(): Router {
  const router = Router();

  // Discord Activity URL Mapping: /.proxy/api/* chega aqui como /api/*
  router.use((req, _res, next) => {
    if (req.url && req.url.startsWith('/.proxy/api/')) req.url = req.url.replace('/.proxy', '');
    next();
  });

  // CORS restrito (própria origem + ALLOWED_ORIGINS), rate limit por IP e token de sessão em toda a /api
  router.use(apiGate);

  router.use('/api/session', handleSession);
  router.use('/api/status', handleStatus);
  router.use('/api/room', handleRoomInfo);
  router.use('/api/upload', (req, res, next) => (req.method === 'POST' ? handleUpload(req, res) : next()));
  router.use('/api/uploads', handleUploadServe);
  router.use('/api/drive', (req, res) => void handleDrive(req, res));
  router.use('/api/token', (req, res) => void handleToken(req, res));
  router.use('/api/proxy', (req, res) => void handleProxy(req, res));
  router.use('/api/resolve', (req, res) => void handleResolve(req, res));
  router.use('/api/tracks', (req, res) => void handleTracks(req, res));
  router.use('/api/subtitle', (req, res) => void handleSubtitle(req, res));
  router.use('/api/font', (req, res) => void handleFont(req, res));
  router.use('/api/hls', (req, res) => void handleHls(req, res));

  return router;
}
