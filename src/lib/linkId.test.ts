import { describe, expect, it } from 'vitest';
import { isLinkId, isRemoteSource } from './linkId';

describe('linkId', () => {
  it('reconhece o id e trata link http(s) e id como fonte remota', () => {
    const id = 'lk_' + 'A1_-'.repeat(5) + 'zz';
    expect(isLinkId(id)).toBe(true);
    expect(isLinkId('lk_curto')).toBe(false);
    expect(isRemoteSource(id)).toBe(true);
    expect(isRemoteSource('https://x.test/a.mkv')).toBe(true);
    expect(isRemoteSource('/api/uploads/abc')).toBe(false);
    expect(isRemoteSource('youtube/abcdefghijk')).toBe(false);
  });
});
