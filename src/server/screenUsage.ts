import { redisKeys, withRedis } from './media/redis';

/**
 * Medidor de uso da transmissão de tela. O relay da Cloudflare ainda não mede nem cobra, então somamos nós mesmos:
 * os bytes que os Hosts publicam e a saída estimada (bytes x espectadores presentes no momento do relato).
 * O total do processo fica na memória; o do dia também vai ao Redis (best-effort, sem esperar).
 */
let hostBytes = 0;
let estimatedEgressBytes = 0;
let since = Date.now();

const COUNTER_TTL_MS = 3 * 24 * 3600 * 1000;

const ok = (n: number) => Number.isFinite(n) && n >= 0;

export function recordScreenUsage(hostDelta: number, viewers: number): void {
  if (!ok(hostDelta) || !ok(viewers)) return;
  const egress = Math.round(hostDelta * viewers);
  hostBytes += hostDelta;
  estimatedEgressBytes += egress;
  if (egress === 0) return;
  const key = redisKeys.screenEgress(new Date().toISOString().slice(0, 10));
  void withRedis(0, async (redis) => {
    await redis.incrby(key, egress);
    await redis.pexpire(key, COUNTER_TTL_MS);
    return 0;
  });
}

export function getScreenUsage(): { hostBytes: number; estimatedEgressBytes: number; since: number } {
  return { hostBytes, estimatedEgressBytes, since };
}

export function resetScreenUsageForTests(): void {
  hostBytes = 0;
  estimatedEgressBytes = 0;
  since = Date.now();
}
