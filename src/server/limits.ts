import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { config } from './config';

/** IP do cliente. Atrás de proxy reverso (`TRUST_PROXY=1`) usa o último salto de X-Forwarded-For. */
export function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const raw = Array.isArray(fwd) ? fwd.join(',') : fwd;
    const last = raw?.split(',').pop()?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress || 'unknown';
}

// ───────────── Rate limit (janela fixa por IP + grupo de rotas) ─────────────

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

export interface RateRule {
  max: number;
  windowMs: number;
}

/** Retorna `null` se liberado, ou quantos segundos esperar. */
export function checkRate(ip: string, group: string, rule: RateRule): number | null {
  const now = Date.now();
  const key = `${group}|${ip}`;
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + rule.windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return b.count > rule.max ? Math.max(1, Math.ceil((b.resetAt - now) / 1000)) : null;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
}, 60_000).unref();

// ───────────── Limite de processos pesados (FFmpeg / Python) ─────────────

let running = 0;

/** Reserva uma vaga. Devolve a função que a libera (idempotente), ou `null` se o servidor está cheio. */
export function tryAcquireProcessSlot(): (() => void) | null {
  if (running >= config.maxFfmpegProcs) return null;
  running++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running--;
  };
}

export function processSlotsInUse(): number {
  return running;
}

/** `spawn` que ocupa uma vaga até o processo terminar. `null` = sem vaga (responder 503). */
export function spawnLimited(command: string, args: string[], options?: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams | null {
  const release = tryAcquireProcessSlot();
  if (!release) return null;
  const proc = spawn(command, args, options ?? {});
  proc.once('close', release);
  proc.once('error', release);
  return proc;
}
