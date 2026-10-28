import { describe, expect, it } from 'vitest';
import { detectCodecs } from './streamInfo';

describe('detectCodecs', () => {
  it('lê HEVC, Dolby Vision e vários áudios da descrição', () => {
    const r = detectCodecs({
      description: '🎥 BluRay REMUX 🎞️ HEVC 📺 DV | HDR10 🎧 Atmos | DD+ | DD | DTS-HD MA | TrueHD',
    });
    expect(r.videoCodec).toBe('hevc');
    expect(r.dolbyVision).toBe(true);
    expect(r.audio).toEqual(expect.arrayContaining(['eac3', 'ac3', 'dts', 'truehd']));
  });

  it('lê AVC e AAC', () => {
    const r = detectCodecs({ description: '🎞️ AVC 🎧 AAC 🔊 2.0' });
    expect(r.videoCodec).toBe('h264');
    expect(r.audio).toEqual(['aac']);
  });

  it('usa só o filename', () => {
    const r = detectCodecs({ filename: 'x.1080p.WEB-DL.x265.AAC.mkv' });
    expect(r.videoCodec).toBe('hevc');
    expect(r.audio).toEqual(['aac']);
  });

  it('o nome do arquivo vence a descrição', () => {
    const r = detectCodecs({ filename: 'x.1080p.x264.mkv', description: 'HEVC' });
    expect(r.videoCodec).toBe('h264');
  });

  it('sem codec nenhum', () => {
    const r = detectCodecs({ name: 'Servidor 1', description: '1080p' });
    expect(r).toEqual({ dolbyVision: false, audio: [] });
    expect(r.videoCodec).toBeUndefined();
  });

  it('DV só vale como palavra inteira', () => {
    expect(detectCodecs({ name: 'Filme DVDRip' }).dolbyVision).toBe(false);
    expect(detectCodecs({ name: 'Filme Dolby Vision' }).dolbyVision).toBe(true);
  });

  it('separa eac3 de ac3', () => {
    expect(detectCodecs({ description: 'DD+' }).audio).toEqual(['eac3']);
    expect(detectCodecs({ description: 'E-AC3' }).audio).toEqual(['eac3']);
    expect(detectCodecs({ description: 'E-AC-3' }).audio).toEqual(['eac3']);
    expect(detectCodecs({ description: 'DD' }).audio).toEqual(['ac3']);
    expect(detectCodecs({ description: 'AC3' }).audio).toEqual(['ac3']);
    expect(detectCodecs({ description: 'DD+ | DD' }).audio).toEqual(['eac3', 'ac3']);
  });

  it('AC3 depois de hífen de release continua ac3', () => {
    expect(detectCodecs({ description: 'WEB-AC3' }).audio).toEqual(['ac3']);
    expect(detectCodecs({ description: 'BluRay-AC3' }).audio).toEqual(['ac3']);
    expect(detectCodecs({ filename: 'x.WEB-DL.AC3.mkv' }).audio).toEqual(['ac3']);
  });
});
