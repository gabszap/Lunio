import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isInternalPath, looksLikeFileRequest, mountStatic } from '../static';

/**
 * Fallback do SPA: só rotas do app recebem o index.html. Arquivos internos/sensíveis e pedidos de
 * arquivo que não existem viram 404, sem tocar em `/`, nas rotas do SPA nem nos assets reais.
 */

let root: string;
let server: http.Server;
let port: number;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunio-static-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Lunio</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log("ok")');
  fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.mkdirSync(path.join(dist, '.well-known'));
  fs.writeFileSync(path.join(dist, '.well-known', 'security.txt'), 'Contact: mailto:ola@exemplo.test');
  // Segredos que NUNCA podem sair: um dentro do dist (dotfile) e um ao lado dele
  fs.writeFileSync(path.join(dist, '.env'), 'SEGREDO_NO_DIST=1');
  fs.writeFileSync(path.join(root, '.env'), 'SEGREDO_FORA_DO_DIST=1');

  const app = express();
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
  mountStatic(app, dist);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(root, { recursive: true, force: true });
});

/** GET com o caminho exatamente como escrito (o `fetch` normalizaria `..` e `%2e`). */
function get(rawPath: string, method = 'GET'): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode || 0, type: String(res.headers['content-type'] || ''), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('rotas do app e arquivos reais', () => {
  it('a home e as rotas do SPA recebem o index.html', async () => {
    for (const p of ['/', '/sala/ABCD1234', '/qualquer-rota']) {
      const res = await get(p);
      expect(res.status, p).toBe(200);
      expect(res.body, p).toContain('<title>Lunio</title>');
    }
  });

  it('assets e arquivos reais continuam saindo, com o cache certo', async () => {
    const js = await get('/assets/app-abc123.js');
    expect(js.status).toBe(200);
    expect(js.body).toBe('console.log("ok")');
    const svg = await get('/favicon.svg');
    expect(svg.status).toBe(200);
    expect(svg.type).toContain('image/svg+xml');
  });

  it('/api desconhecida continua sendo JSON 404, não o HTML', async () => {
    const res = await get('/api/nada');
    expect(res.status).toBe(404);
    expect(res.type).toContain('application/json');
  });
});

describe('caminhos internos e pedidos de arquivo', () => {
  const internos = [
    '/.env',
    '/.env.local',
    '/.env.production',
    '/.git/config',
    '/.git/HEAD',
    '/.htaccess',
    '/.DS_Store',
    '/.well-known/security.txt',
    '/assets/.env',
    '/sala/.git/config',
  ];
  it.each(internos)('%s → 404 e sem conteúdo do app', async (p) => {
    const res = await get(p);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('SEGREDO');
    expect(res.body).not.toContain('<title>Lunio</title>');
  });

  const arquivos = ['/backup.sql', '/dump.sql.gz', '/package.json', '/config.json', '/src/server/config.ts', '/wp-login.php', '/assets/sumiu.js', '/id_rsa.pub'];
  it.each(arquivos)('%s (arquivo que não existe) → 404, não o HTML', async (p) => {
    const res = await get(p);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('<title>Lunio</title>');
  });

  const disfarcados = ['/%2e%2e/.env', '/%2e%2e%2f.env', '/..%2f.env', '/assets/%2e%2e/%2e%2e/.env', '/%2eenv', '/.%65nv', '/%00', '/%E0%A4%A', '/..\\.env', '/assets/..%5c..%5c.env'];
  it.each(disfarcados)('%s (traversal/codificação) → 404 e nenhum segredo', async (p) => {
    const res = await get(p);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('SEGREDO');
  });

  it('HEAD também respeita a regra', async () => {
    expect((await get('/.env', 'HEAD')).status).toBe(404);
    expect((await get('/', 'HEAD')).status).toBe(200);
  });
});

describe('classificação do caminho', () => {
  it('isInternalPath', () => {
    expect(isInternalPath('/.env')).toBe(true);
    expect(isInternalPath('/a/.git/config')).toBe(true);
    expect(isInternalPath('/.well-known/acme-challenge/x')).toBe(true);
    expect(isInternalPath('/sala/ABCD')).toBe(false);
    expect(isInternalPath('/%E0%A4%A')).toBe(true);
  });

  it('looksLikeFileRequest', () => {
    expect(looksLikeFileRequest('/')).toBe(false);
    expect(looksLikeFileRequest('/sala/ABCD')).toBe(false);
    expect(looksLikeFileRequest('/x.js')).toBe(true);
    expect(looksLikeFileRequest('/a/b/dump.sql')).toBe(true);
  });
});
