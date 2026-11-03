import { describe, expect, it } from 'vitest';
import { streamMediaInfo } from './streamMime';

describe('streamMediaInfo', () => {
  it('o nome do arquivo vale mais que a URL', () => {
    expect(streamMediaInfo('https://cdn.test/a.mkv', 'filme.mp4')).toEqual({ mimeType: 'video/mp4', isMkv: false });
  });
  it('ignora query e fragmento da URL', () => {
    expect(streamMediaInfo('https://cdn.test/a.webm?token=x.mkv#y').mimeType).toBe('video/webm');
    expect(streamMediaInfo('https://cdn.test/a.m4v?x=1').mimeType).toBe('video/mp4');
  });
  it('extensão em maiúsculas', () => {
    expect(streamMediaInfo('https://cdn.test/A.MP4').mimeType).toBe('video/mp4');
    expect(streamMediaInfo('https://cdn.test/a', 'EP.MKV')).toEqual({ mimeType: 'video/x-matroska', isMkv: true });
  });
  it('sem extensão usa o padrão', () => {
    expect(streamMediaInfo('https://cdn.test/stream/123')).toEqual({ mimeType: 'video/x-matroska', isMkv: false });
  });
  it('URL do torrentio sem extensão é mkv', () => {
    expect(streamMediaInfo('https://torrentio.strem.fun/resolve/x/y').isMkv).toBe(true);
  });
});
