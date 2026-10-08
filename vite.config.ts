import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, createLogger, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import { createApiRouter } from './src/server/app';
import { startBackend } from './src/server/boot';

/** Só o que o backend usa: igual no servidor de dev (`vite`) e no de preview (`vite preview`). */
type BackendHost = {
  middlewares: ViteDevServer['middlewares'];
  httpServer: ViteDevServer['httpServer'] | PreviewServer['httpServer'] | null;
};

/**
 * Pluga o backend (src/server/app.ts) no Vite. Em produção o backend roda sem o Vite: `npm run serve` (src/server/main.ts).
 */
function backendPlugin(): Plugin {
  const setup = (server: BackendHost) => {
    startBackend(server.httpServer as import('node:http').Server | null);
    server.middlewares.use(createApiRouter());
  };
  return {
    name: 'lunio-backend',
    configureServer: setup,
    configurePreviewServer: setup,
  };
}

const customViteLogger = createLogger();
const originalLoggerWarn = customViteLogger.warn;
customViteLogger.warn = (msg, options) => {
  if (
    msg.includes('points to missing source files') ||
    msg.includes('jassub-worker') ||
    msg.includes('SOURCEMAP_ERROR')
  ) {
    return;
  }
  originalLoggerWarn(msg, options);
};

export default defineConfig(() => {
  return {
    customLogger: customViteLogger,
    plugins: [react(), tailwindcss(), backendPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        throughput: path.resolve(__dirname, 'src/throughput-shim.js'),
      },
    },
    optimizeDeps: {
      exclude: ['jassub'],
    },
    worker: {
      format: 'es' as const,
    },
    build: {
      // O hls.js (~595 kB) é um pedaço sob demanda que não dá para dividir; o aviso do Vite deve valer só para o pacote inicial
      chunkSizeWarningLimit: 650,
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      allowedHosts: true as const,
      // CORS é responsabilidade da nossa /api (src/server/cors.ts), não do Vite (`*`)
      cors: false,
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: {
        ignored: [
          // Testes e relatórios não fazem parte do app: mexer neles não deve recarregar nem reiniciar o dev server
          '**/e2e/**',
          '**/logs/**',
          '**/test-results/**',
          '**/playwright-report/**',
          '**/.playwright/**',
          '**/.cache/**',
          '**/.uploads/**',
          '**/cache/**',
          '**/*.ass',
          '**/*.srt',
          '**/*.vtt',
          '**/*.txt',
          '**/*.log',
          '**/log*',
          '**/log*.txt',
          '**/.git/**',
          '**/node_modules/**',
        ],
      },
    },
    preview: {
      port: 3000,
      host: '0.0.0.0',
      allowedHosts: true as const,
      cors: false,
    },
  };
});
