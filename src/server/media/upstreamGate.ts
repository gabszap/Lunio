/**
 * Portão por host do CDN para as extrações de legenda (mkv_extractor e FFmpeg).
 *
 * O CDN do TorBox limita conexões simultâneas por origem e responde 429. Disparar várias extrações de uma vez,
 * ainda por cima com retry e FFmpeg de fallback abrindo outra conexão, só piora: tudo é recusado.
 * Aqui as extrações do mesmo host entram em fila (uma por vez), as pedidas pelo usuário passam na frente das
 * pré-extrações em segundo plano, e depois de um 429 o host fica em espera antes de a próxima começar.
 */

export type GatePriority = 'interactive' | 'prefetch';

interface Job<T> {
  priority: GatePriority;
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

interface HostState {
  running: boolean;
  queue: Job<any>[];
  cooldownUntil: number;
}

/** Quanto esperar depois de um 429 sem `Retry-After`, e o teto para um `Retry-After` exagerado. */
export const DEFAULT_COOLDOWN_MS = 15_000;
export const MAX_COOLDOWN_MS = 60_000;

const hosts = new Map<string, HostState>();

function stateOf(host: string): HostState {
  let s = hosts.get(host);
  if (!s) {
    s = { running: false, queue: [], cooldownUntil: 0 };
    hosts.set(host, s);
  }
  return s;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'desconhecido';
  }
}

/** O host respondeu 429: nada novo começa nele até passar o tempo. */
export function noteRateLimited(host: string, retryAfterSec?: number) {
  const ms = Math.min(MAX_COOLDOWN_MS, retryAfterSec && retryAfterSec > 0 ? retryAfterSec * 1000 : DEFAULT_COOLDOWN_MS);
  const s = stateOf(host);
  s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + ms);
}

export function cooldownRemainingMs(host: string): number {
  return Math.max(0, stateOf(host).cooldownUntil - Date.now());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pump(host: string) {
  const s = stateOf(host);
  if (s.running) return;
  s.running = true;
  try {
    while (s.queue.length > 0) {
      const idx = s.queue.findIndex((j) => j.priority === 'interactive');
      const job = s.queue.splice(idx >= 0 ? idx : 0, 1)[0];
      const wait = cooldownRemainingMs(host);
      if (wait > 0) await sleep(wait);
      try {
        job.resolve(await job.run());
      } catch (e) {
        job.reject(e);
      }
    }
  } finally {
    s.running = false;
  }
}

/** Enfileira `run` no host; só uma execução por host de cada vez. */
export function runOnHost<T>(host: string, priority: GatePriority, run: () => Promise<T>): { promise: Promise<T>; bump: () => void } {
  const s = stateOf(host);
  let job!: Job<T>;
  const promise = new Promise<T>((resolve, reject) => {
    job = { priority, run, resolve, reject };
  });
  s.queue.push(job);
  void pump(host);
  return {
    promise,
    /** Quem estava só pré-carregando agora foi pedido pelo usuário: passa na frente da fila. */
    bump: () => {
      job.priority = 'interactive';
    },
  };
}

/** Só para testes. */
export function resetGateForTests() {
  hosts.clear();
}
