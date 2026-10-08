import { spawnSync } from 'node:child_process';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { WebSocket } from 'ws';

/** Tamanho total de uma pasta (0 se não existe). Usado para dimensionar cotas de teste. */
export function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    }
  } catch {
    // pasta ainda não existe
  }
  return total;
}

/** Sobe a API (router do Express) numa porta livre. */
export async function startApi(createApiRouter: () => express.Router) {
  const app = express();
  app.use(createApiRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** WebSocket falso para entrar numa sala sem abrir rede. */
export class FakeSocket {
  readyState = 1;
  sent: any[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  last(type: string) {
    return this.sent.filter((m) => m.type === type).at(-1);
  }
}
export const asWs = (s: FakeSocket) => s as unknown as WebSocket;

export function joinRoom(manager: { handleClientMessage(ws: WebSocket, raw: string): void }, roomId: string, userId: string) {
  const socket = new FakeSocket();
  manager.handleClientMessage(asWs(socket), JSON.stringify({ type: 'room:join', roomId, user: { id: userId, username: userId } }));
  const token = socket.last('room:state')?.accessToken as string;
  return { socket, token };
}

export function hasBinary(cmd: string, args: string[] = ['-version']): boolean {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/** Servidor estático com HTTP Range (o que o proxy e o mkv_extractor esperam de um CDN). */
export async function startRangeServer(dir: string) {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, path.basename((req.url || '').split('?')[0]));
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      res.writeHead(404);
      return res.end();
    }
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const type = file.endsWith('.mkv') ? 'video/x-matroska' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    if (m) {
      const start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]);
      const end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      return void fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
