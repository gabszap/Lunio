import { describe, expect, it } from 'vitest';
import { parseTracks, parseVideoLine, videoLineForLog } from '../media/tracks';

describe('parseVideoLine: lê o vídeo da saída do FFmpeg', () => {
  it('HEVC 10 bits com perfil', () => {
    expect(parseVideoLine('Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, progressive), 3840x2160 [SAR 1:1 DAR 16:9], 24 fps, 24 tbr, 1k tbn')).toEqual({
      codec: 'hevc',
      profile: 'Main 10',
      pixFmt: 'yuv420p10le',
      width: 3840,
      height: 2160,
    });
  });

  it('H.264 comum: a etiqueta do contêiner entre parênteses não vira "perfil"', () => {
    expect(parseVideoLine('Stream #0:0(eng): Video: h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 23.98 fps')).toMatchObject({
      codec: 'h264',
      profile: 'High',
      pixFmt: 'yuv420p',
      width: 1920,
      height: 1080,
    });
    expect(parseVideoLine('Stream #0:0: Video: h264 (avc1 / 0x31637661), yuv420p, 1280x720, 30 fps')).toMatchObject({ codec: 'h264', profile: '', width: 1280 });
  });

  it('AV1 e VP9', () => {
    // O primeiro parêntese do AV1 é o decodificador do FFmpeg, não o perfil
    expect(parseVideoLine('Stream #0:0: Video: av1 (libdav1d) (Main), yuv420p(tv), 640x360, 24 fps')).toMatchObject({ codec: 'av1', profile: 'Main', width: 640, height: 360 });
    expect(parseVideoLine('Stream #0:0: Video: av1 (libdav1d), yuv420p, 640x360, 24 fps')).toMatchObject({ codec: 'av1', profile: '' });
    expect(parseVideoLine('Stream #0:0: Video: vp9 (Profile 2), yuv420p10le(tv), 1920x1080, 24 fps')).toMatchObject({ codec: 'vp9', pixFmt: 'yuv420p10le' });
  });

  it('linha que não é de vídeo devolve null', () => {
    expect(parseVideoLine('Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp')).toBeNull();
  });
});

describe('parseTracks: guarda o vídeo principal', () => {
  const header = `Input #0, matroska,webm, from 'x.mkv':
  Duration: 00:24:39.50, start: 0.000000, bitrate: 6500 kb/s
`;

  it('o primeiro vídeo vale; capa (attached pic) não conta', () => {
    const out =
      header +
      `  Stream #0:0: Video: mjpeg (Baseline), yuvj420p(pc), 600x600 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)
  Stream #0:1(jpn): Video: hevc (Main 10), yuv420p10le(tv), 1920x1080, 23.98 fps
  Stream #0:2(jpn): Audio: aac (LC), 48000 Hz, stereo, fltp
`;
    const result = parseTracks(out, 'https://exemplo.test/x.mkv', 'https://exemplo.test/x.mkv');
    expect(result.video).toMatchObject({ codec: 'hevc', pixFmt: 'yuv420p10le', width: 1920, height: 1080 });
  });

  it('arquivo sem vídeo: null', () => {
    const result = parseTracks(header + '  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp\n', 'https://exemplo.test/a.mp3', 'https://exemplo.test/a.mp3');
    expect(result.video).toBeNull();
  });
});

describe('videoLineForLog: a linha do vídeo para o journal', () => {
  it('devolve a primeira linha de vídeo de verdade, sem capa e sem URL', () => {
    const out = [
      "Input #0, matroska,webm, from 'https://cdn.exemplo.test/video.mkv?token=SEGREDO':",
      '  Stream #0:0: Video: mjpeg (Baseline), yuvj420p(pc), 600x600, 90k tbr (attached pic)',
      '  Stream #0:1(jpn): Video: hevc (Main 10), yuv420p10le(tv), 1920x1080, 23.98 fps, 23.98 tbr, 1k tbn',
      '  Stream #0:2(jpn): Audio: aac (LC), 48000 Hz, stereo, fltp',
    ].join('\n');
    const line = videoLineForLog(out)!;
    expect(line).toBe('Stream #0:1(jpn): Video: hevc (Main 10), yuv420p10le(tv), 1920x1080, 23.98 fps, 23.98 tbr, 1k tbn');
    expect(line).not.toContain('SEGREDO');
  });

  it('troca URL que aparecer na linha e limita o tamanho; sem vídeo, null', () => {
    const noisy = 'Stream #0:0: Video: h264 (High), yuv420p, 1280x720, handler_name https://x.test/a?t=abc ' + 'z'.repeat(400);
    const line = videoLineForLog(noisy)!;
    expect(line).toContain('[url]');
    expect(line.length).toBeLessThanOrEqual(300);
    expect(videoLineForLog('Stream #0:0: Audio: mp3, 44100 Hz')).toBeNull();
  });
});
