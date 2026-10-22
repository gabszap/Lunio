// Addon Stremio de mentira para o E2E e para conferência no navegador: manifesto + streams, com CORS aberto.
// O H.264 aponta para o fixture de vídeo (e2e/fixture-server.mjs, porta 3101, serve teste.mkv).
import http from 'node:http';

const port = Number(process.argv[2]) || 3102;
const fixture = process.env.FIXTURE_URL || 'http://127.0.0.1:3101/teste.mkv';

const manifest = {
  id: 'test.lunio.fake',
  version: '1.0.0',
  name: 'Addon de teste',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

const streams = [
  { name: 'Teste', title: 'Filme.1080p.H264.mkv', url: fixture },
  { name: 'Teste', title: 'Filme.2160p.HEVC.mkv', url: 'http://127.0.0.1:3101/codec-hevc.mkv' },
  { name: 'Teste', title: 'Filme.720p.mkv', behaviorHints: { notWebReady: true }, url: 'http://127.0.0.1:3101/teste.mkv?nwr=1' },
];

http
  .createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    const path = (req.url || '').split('?')[0];
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
    if (path === '/manifest.json') return void res.writeHead(200, cors).end(JSON.stringify(manifest));
    if (/^\/stream\/(movie|series)\/[^/]+\.json$/.test(path)) return void res.writeHead(200, cors).end(JSON.stringify({ streams }));
    res.writeHead(404, cors).end('{}');
  })
  .listen(port, '127.0.0.1', () => console.log(`addon de teste em http://127.0.0.1:${port}/manifest.json`));
