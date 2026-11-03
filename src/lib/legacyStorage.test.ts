import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyStorage } from './legacyStorage';

function fakeStorage(initial: Record<string, string>): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe('migrateLegacyStorage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renomeia streamplayer_* para lunio_* sem sobrescrever o que já existe', () => {
    const local = fakeStorage({ streamplayer_progress_a: '5', streamplayer_recent_streams: '[1]', lunio_recent_streams: '[2]', outro: 'x' });
    const session = fakeStorage({ streamplayer_watchparty_user: '{}' });
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    migrateLegacyStorage();
    expect(local.getItem('lunio_progress_a')).toBe('5');
    expect(local.getItem('lunio_recent_streams')).toBe('[2]');
    expect(local.getItem('streamplayer_recent_streams')).toBeNull();
    expect(local.getItem('outro')).toBe('x');
    expect(session.getItem('lunio_watchparty_user')).toBe('{}');
    expect(session.getItem('streamplayer_watchparty_user')).toBeNull();
  });
});
