import { describe, expect, it } from 'vitest';
import { screenMenuState } from './availability';

const ok = { discord: false, hostCapable: true, enabled: true };

describe('screenMenuState (the "Share your screen" option on the Home menu)', () => {
  it('is available for a capable browser on a server with screen sharing on', () => {
    expect(screenMenuState(ok)).toBe('available');
  });

  it('is unavailable inside Discord, in a browser that cannot host, or when the server has it off', () => {
    expect(screenMenuState({ ...ok, discord: true })).toBe('unavailable');
    expect(screenMenuState({ ...ok, hostCapable: false })).toBe('unavailable');
    expect(screenMenuState({ ...ok, enabled: false })).toBe('unavailable');
  });

  it('is still checking while the server answer is unknown, but a browser that cannot host never waits', () => {
    expect(screenMenuState({ ...ok, enabled: null })).toBe('checking');
    expect(screenMenuState({ ...ok, enabled: null, hostCapable: false })).toBe('unavailable');
    expect(screenMenuState({ ...ok, enabled: null, discord: true })).toBe('unavailable');
  });
});
