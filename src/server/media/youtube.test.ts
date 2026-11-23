import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  filterAndRewriteMasterManifest,
  getYouTubeProxyTarget,
  isAllowedYouTubeUrl,
  rewriteVariantPlaylist,
} from './youtube';
import { handleYouTube } from '../routes/youtube';

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

function mockReqRes(method: string, url: string) {
  const headers: Record<string, string> = {};
  let body = '';
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = String(v);
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
      this.headersSent = true;
      this.writableEnded = true;
    },
  };
  const req = {
    method,
    url,
    headers: {},
    once() {},
  };
  return {
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    headers,
    getBody: () => body,
    getStatus: () => res.statusCode,
  };
}

describe('YouTube HLS manifest rewriter & security', () => {
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

  it('resolve URIs relativas contra a base permitida e descarta hosts não autorizados', () => {
    const seen: string[] = [];
    const raw = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:5.0,
seg0.ts
#EXTINF:5.0,
http://169.254.169.254/latest/meta-data/
#EXTINF:5.0,
https://evil.example.com/steal.ts
#EXT-X-ENDLIST`;
    const out = rewriteVariantPlaylist(
      raw,
      (u) => {
        seen.push(u);
        return `s${seen.length}`;
      },
      '?t=xyz',
      'https://rr1.googlevideo.com/videoplayback/index.m3u8'
    );
    expect(seen).toEqual([
      'https://rr1.googlevideo.com/videoplayback/init.mp4',
      'https://rr1.googlevideo.com/videoplayback/seg0.ts',
    ]);
    expect(out).toContain('#EXT-X-MAP:URI="/api/youtube/seg/s1.ts?t=xyz"');
    expect(out).toContain('/api/youtube/seg/s2.ts?t=xyz');
    expect(out).not.toContain('169.254.169.254');
    expect(out).not.toContain('evil.example.com');
  });

  it('valida estritamente URLs permitidas do YouTube (rejeita SSRF, HTTP e domínios externos)', () => {
    expect(isAllowedYouTubeUrl('https://rr1---sn-abc.googlevideo.com/videoplayback')).toBe(true);
    expect(isAllowedYouTubeUrl('https://www.youtube.com/api/timedtext?v=abc')).toBe(true);
    expect(isAllowedYouTubeUrl('http://rr1.googlevideo.com/videoplayback')).toBe(false);
    expect(isAllowedYouTubeUrl('https://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isAllowedYouTubeUrl('https://localhost/secret')).toBe(false);
    expect(isAllowedYouTubeUrl('https://googlevideo.com.evil.example/seg.ts')).toBe(false);
  });

  it('rejeita tokens inválidos ou com tipo incorreto', () => {
    expect(getYouTubeProxyTarget('not-hex', 'seg')).toBeNull();
    expect(getYouTubeProxyTarget('a'.repeat(24), 'hls')).toBeNull();
  });

  it('handleYouTube recusa métodos diferentes de GET/HEAD e valida IDs/tokens', async () => {
    const post = mockReqRes('POST', '/info?id=dQw4w9WgXcQ');
    await handleYouTube(post.req, post.res);
    expect(post.getStatus()).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');

    const badId = mockReqRes('GET', '/info?id=invalido');
    await handleYouTube(badId.req, badId.res);
    expect(badId.getStatus()).toBe(400);
    expect(JSON.parse(badId.getBody()).code).toBe('invalid_video_id');

    const missingSeg = mockReqRes('GET', `/seg/${'a'.repeat(24)}.ts`);
    await handleYouTube(missingSeg.req, missingSeg.res);
    expect(missingSeg.getStatus()).toBe(404);
  });
});
