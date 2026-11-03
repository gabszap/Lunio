import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isValidScreenEpoch,
  isValidScreenKey,
  newScreenSession,
  relayUrlFor,
  sanitizeUsageBytes,
  screenShareEnabled,
  type ScreenShareConfig,
} from '../screenShare';

const cfg: ScreenShareConfig = {
  enabled: true,
  relayUrl: 'https://relay.test',
  publishToken: 'TOKPUB',
  subscribeToken: 'TOKSUB',
  maxLive: 10,
};

describe('newScreenSession', () => {
  it('builds an unguessable path and ids, not live yet', () => {
    const s = newScreenSession('SALA1', 'host', '1080p60', 1000);
    expect(s.path).toMatch(/^lunio\/SALA1\/[0-9a-f]{32}$/);
    expect(s.sessionId).toMatch(/^[0-9a-f]{16}$/);
    expect(s).toMatchObject({ hostId: 'host', quality: '1080p60', live: false, startedAt: 1000 });
  });

  it('gives a different path every time', () => {
    expect(newScreenSession('SALA1', 'h', '720p30').path).not.toBe(newScreenSession('SALA1', 'h', '720p30').path);
  });
});

describe('isValidScreenKey', () => {
  it('accepts exactly 32 bytes of base64', () => {
    expect(isValidScreenKey(Buffer.alloc(32, 7).toString('base64'))).toBe(true);
  });

  it('refuses other sizes, loose base64 and non-strings', () => {
    expect(isValidScreenKey(Buffer.alloc(31, 7).toString('base64'))).toBe(false);
    expect(isValidScreenKey(Buffer.alloc(33, 7).toString('base64'))).toBe(false);
    expect(isValidScreenKey('')).toBe(false);
    expect(isValidScreenKey('***')).toBe(false);
    expect(isValidScreenKey(12345)).toBe(false);
    expect(isValidScreenKey(null)).toBe(false);
    // 32 bytes válidos seguidos de lixo que o decodificador do Node ignora
    expect(isValidScreenKey(Buffer.alloc(32, 7).toString('base64') + '!!')).toBe(false);
  });
});

describe('isValidScreenEpoch', () => {
  it('accepts integers from 1 to 2**31', () => {
    expect(isValidScreenEpoch(1)).toBe(true);
    expect(isValidScreenEpoch(2 ** 31)).toBe(true);
  });

  it('refuses everything else', () => {
    for (const v of [0, -1, 1.5, NaN, 2 ** 31 + 1, '2']) expect(isValidScreenEpoch(v)).toBe(false);
  });
});

describe('sanitizeUsageBytes', () => {
  it('returns the accepted delta', () => {
    expect(sanitizeUsageBytes(150, 100)).toBe(50);
    expect(sanitizeUsageBytes(100, 100)).toBe(0);
  });

  it('refuses a counter that went back, bad numbers and absurd jumps', () => {
    expect(sanitizeUsageBytes(90, 100)).toBeNull();
    expect(sanitizeUsageBytes(-1, 0)).toBeNull();
    expect(sanitizeUsageBytes(NaN, 0)).toBeNull();
    expect(sanitizeUsageBytes(Infinity, 0)).toBeNull();
    expect(sanitizeUsageBytes('9', 0)).toBeNull();
    expect(sanitizeUsageBytes(11 * 1024 ** 3, 0)).toBeNull();
  });
});

describe('relayUrlFor / screenShareEnabled', () => {
  it('uses the publish token for the host and the subscribe token for the rest', () => {
    expect(relayUrlFor('publish', cfg)).toBe('https://relay.test/TOKPUB');
    expect(relayUrlFor('subscribe', cfg)).toBe('https://relay.test/TOKSUB');
  });

  it('returns null when disabled', () => {
    expect(relayUrlFor('publish', { ...cfg, enabled: false })).toBeNull();
    expect(screenShareEnabled({ ...cfg, enabled: false })).toBe(false);
    expect(screenShareEnabled(cfg)).toBe(true);
  });
});

describe('config.screenShare', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(env: Record<string, string>) {
    // o .env do desenvolvedor pode ter valores reais: zera tudo o que a seção lê
    const base = {
      SCREEN_SHARE_ENABLED: '',
      SCREEN_SHARE_MAX_LIVE: '',
      MOQ_RELAY_URL: '',
      MOQ_TOKEN_PUBLISH: '',
      MOQ_TOKEN_SUBSCRIBE: '',
    };
    for (const [k, v] of Object.entries({ ...base, ...env })) vi.stubEnv(k, v);
    vi.resetModules();
    return (await import('../config')).config.screenShare;
  }

  const ok = { SCREEN_SHARE_ENABLED: '1', MOQ_RELAY_URL: 'https://relay.test/', MOQ_TOKEN_PUBLISH: 'a', MOQ_TOKEN_SUBSCRIBE: 'b' };

  it('is enabled with the flag, an https relay and both tokens, without the trailing slash', async () => {
    const c = await load(ok);
    expect(c.enabled).toBe(true);
    expect(c.relayUrl).toBe('https://relay.test');
  });

  it('is disabled without the flag, without a token or with an http relay', async () => {
    expect((await load({ ...ok, SCREEN_SHARE_ENABLED: '' })).enabled).toBe(false);
    expect((await load({ ...ok, MOQ_TOKEN_SUBSCRIBE: '' })).enabled).toBe(false);
    expect((await load({ ...ok, MOQ_RELAY_URL: 'http://relay.test' })).enabled).toBe(false);
  });

  it('falls back to 10 live broadcasts when the limit is not a number', async () => {
    expect((await load({ ...ok, SCREEN_SHARE_MAX_LIVE: 'abc' })).maxLive).toBe(10);
    expect((await load({ ...ok, SCREEN_SHARE_MAX_LIVE: '3' })).maxLive).toBe(3);
  });
});
