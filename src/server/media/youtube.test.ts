import { describe, expect, it } from 'vitest';
import { filterAndRewriteMasterManifest, rewriteVariantPlaylist } from './youtube';

const SAMPLE_MASTER = `#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:URI="https://manifest.googlevideo.com/audio/233.m3u8",TYPE=AUDIO,GROUP-ID="233",NAME="Default",DEFAULT=YES
#EXT-X-MEDIA:URI="https://manifest.googlevideo.com/audio/234.m3u8",TYPE=AUDIO,GROUP-ID="234",NAME="Default",DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.4D401F,mp4a.40.5",RESOLUTION=854x480,FRAME-RATE=30,AUDIO="233"
https://manifest.googlevideo.com/v/480_low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=920000,CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=854x480,FRAME-RATE=30,AUDIO="234"
https://manifest.googlevideo.com/v/480_hi.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.64002A,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=60,AUDIO="234"
https://manifest.googlevideo.com/v/1080_avc.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3800000,CODECS="vp09.00.41.08,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=60,AUDIO="234"
https://manifest.googlevideo.com/v/1080_vp9.m3u8
`;

describe('YouTube HLS manifest rewriter', () => {
  it('mantém apenas faixas H.264 (avc1), deduplica por resolução preferindo áudio 234 e reescreve URIs com token', () => {
    const seen = new Map<string, string>();
    let seq = 0;
    const reg = (u: string) => {
      const id = `tok_${++seq}`;
      seen.set(id, u);
      return id;
    };

    const { playlist, streamCount } = filterAndRewriteMasterManifest(SAMPLE_MASTER, reg, '?t=abc');
    expect(streamCount).toBe(2);
    expect(playlist).not.toContain('vp09');
    expect(playlist).not.toContain('GROUP-ID="233"');
    expect(playlist).toContain('GROUP-ID="234"');
    expect(playlist).toContain('URI="/api/youtube/hls/tok_1.m3u8?t=abc"');
    expect(playlist).toContain('/api/youtube/hls/tok_2.m3u8?t=abc');
    expect(playlist).toContain('/api/youtube/hls/tok_3.m3u8?t=abc');
    expect(seen.get('tok_1')).toBe('https://manifest.googlevideo.com/audio/234.m3u8');
    expect(seen.get('tok_2')).toBe('https://manifest.googlevideo.com/v/480_hi.m3u8');
    expect(seen.get('tok_3')).toBe('https://manifest.googlevideo.com/v/1080_avc.m3u8');
  });

  it('reescreve segmentos e #EXT-X-MAP na playlist variante', () => {
    let seq = 0;
    const raw = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MAP:URI="https://rr1.googlevideo.com/init.mp4"
#EXTINF:5.0,
https://rr1.googlevideo.com/seg0.ts
#EXTINF:5.0,
https://rr1.googlevideo.com/seg1.ts
#EXT-X-ENDLIST`;
    const out = rewriteVariantPlaylist(raw, () => `s${++seq}`, '?t=xyz');
    expect(out).toContain('#EXT-X-MAP:URI="/api/youtube/seg/s1.ts?t=xyz"');
    expect(out).toContain('/api/youtube/seg/s2.ts?t=xyz');
    expect(out).toContain('/api/youtube/seg/s3.ts?t=xyz');
  });
});
