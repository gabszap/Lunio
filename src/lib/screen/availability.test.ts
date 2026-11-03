import { describe, expect, it } from 'vitest';
import type { RoomScreen } from '../../types/screen';
import { isOwnOrphan, screenAvailability } from './availability';

const ok = { discord: false, capabilities: { host: true }, enabled: true, isHost: true, connected: true };
const screen = (hostId: string): RoomScreen => ({ sessionId: 's', hostId, path: 'p', quality: '1080p60', startedAt: 1, live: true });

describe('screenAvailability', () => {
  it('a connected Host on a capable browser with the server flag on can broadcast', () => {
    expect(screenAvailability(ok)).toEqual({ canBroadcast: true, why: null });
  });

  it.each([
    ['discord', { ...ok, discord: true }],
    ['not-connected', { ...ok, connected: false }],
    ['not-host', { ...ok, isHost: false }],
    ['unsupported', { ...ok, capabilities: { host: false } }],
    ['disabled', { ...ok, enabled: false }],
  ] as const)('%s blocks it', (why, input) => {
    expect(screenAvailability(input)).toEqual({ canBroadcast: false, why });
  });

  it('inside Discord wins over every other reason', () => {
    expect(screenAvailability({ ...ok, discord: true, enabled: false, isHost: false }).why).toBe('discord');
  });
});

describe('isOwnOrphan', () => {
  it('a broadcast of mine with no local session is an orphan (the Host reloaded the page)', () => {
    expect(isOwnOrphan(screen('me'), 'me', false)).toBe(true);
  });

  it('is not an orphan with a local session, someone else’s broadcast or none', () => {
    expect(isOwnOrphan(screen('me'), 'me', true)).toBe(false);
    expect(isOwnOrphan(screen('other'), 'me', false)).toBe(false);
    expect(isOwnOrphan(null, 'me', false)).toBe(false);
  });
});
