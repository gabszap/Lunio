import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatRoomUrl, readRoomFromUrl, roomCodeFrom } from './roomCode';

describe('roomCode & /room/:code URLs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('extrai código de /room/:code, ?room=:code e texto direto', () => {
    expect(roomCodeFrom('8S4LVNTY')).toBe('8S4LVNTY');
    expect(roomCodeFrom('https://lunio.app/room/8s4lvnty')).toBe('8S4LVNTY');
    expect(roomCodeFrom('https://lunio.app/room/8S4LVNTY?t=45')).toBe('8S4LVNTY');
    expect(roomCodeFrom('https://lunio.app/?room=8S4LVNTY')).toBe('8S4LVNTY');
  });

  it('readRoomFromUrl prioriza /room/:code e aceita ?room= legado', () => {
    expect(readRoomFromUrl('https://lunio.app/room/8S4LVNTY')).toBe('8S4LVNTY');
    expect(readRoomFromUrl('https://lunio.app/room/8s4lvnty?t=90')).toBe('8S4LVNTY');
    expect(readRoomFromUrl('https://lunio.app/?room=ABCD1234')).toBe('ABCD1234');
    expect(readRoomFromUrl('https://lunio.app/catalog')).toBeNull();
    expect(readRoomFromUrl('https://lunio.app/home')).toBeNull();
  });

  it('formatRoomUrl gera /room/:code sem ?room=', () => {
    vi.stubGlobal('window', { location: { origin: 'https://lunio.app' } });
    expect(formatRoomUrl('8S4LVNTY')).toBe('https://lunio.app/room/8S4LVNTY');
  });
});
