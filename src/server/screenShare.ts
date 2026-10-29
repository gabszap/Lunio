import crypto from 'node:crypto';
import { config } from './config';
import type { RoomScreen, ScreenQualityId } from '../types/screen';

export type ScreenShareConfig = typeof config.screenShare;

/** Maior salto aceito entre dois relatos de uso (um relato por poucos segundos; 10 GB é absurdo em qualquer qualidade). */
const MAX_USAGE_JUMP_BYTES = 10 * 1024 ** 3;
const MAX_EPOCH = 2 ** 31;

export function screenShareEnabled(cfg: ScreenShareConfig = config.screenShare): boolean {
  return cfg.enabled;
}

/** Sessão nova, ainda não ao vivo. O caminho no relay é imprevisível: quem não está na sala não o adivinha. */
export function newScreenSession(roomId: string, hostId: string, quality: ScreenQualityId, now: number = Date.now()): RoomScreen {
  return {
    sessionId: crypto.randomBytes(8).toString('hex'),
    hostId,
    path: `lunio/${roomId}/${crypto.randomBytes(16).toString('hex')}`,
    quality,
    startedAt: now,
    live: false,
  };
}

/** Chave AES-256: base64 de exatamente 32 bytes, na forma canônica (recusa base64 "frouxo"). */
export function isValidScreenKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length !== 44) return false;
  const raw = Buffer.from(key, 'base64');
  return raw.length === 32 && raw.toString('base64') === key;
}

export function isValidScreenEpoch(epoch: unknown): epoch is number {
  return typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 1 && epoch <= MAX_EPOCH;
}

/** Quanto o contador de bytes do Host cresceu desde o último relato; `null` se o relato não vale. */
export function sanitizeUsageBytes(next: unknown, previous: number): number | null {
  if (typeof next !== 'number' || !Number.isFinite(next) || next < 0 || next < previous) return null;
  const delta = next - previous;
  return delta > MAX_USAGE_JUMP_BYTES ? null : delta;
}

/** Endereço do relay com o token do papel (o de publicar só vai ao Host que transmite). */
export function relayUrlFor(role: 'publish' | 'subscribe', cfg: ScreenShareConfig = config.screenShare): string | null {
  if (!cfg.enabled) return null;
  return `${cfg.relayUrl}/${role === 'publish' ? cfg.publishToken : cfg.subscribeToken}`;
}
