import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { ffmpegMbpsFor, ffmpegSamplesFor, recordFfmpegRead, resetFfmpegSpeed } from '../media/ffmpegSpeed';

const MB = 1_000_000;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  resetFfmpegSpeed();
});

describe('estimativa de velocidade do FFmpeg por host', () => {
  it('sem leituras vale o padrão da configuração', () => {
    expect(ffmpegMbpsFor('cdn.exemplo.test')).toBe(config.ffmpegThroughputMbps);
    expect(ffmpegSamplesFor('cdn.exemplo.test')).toBe(0);
  });

  it('a primeira leitura vira a estimativa e as seguintes entram na média móvel', () => {
    recordFfmpegRead('a.test', 800 * MB, 20_000); // 40 MB/s
    expect(ffmpegMbpsFor('a.test')).toBeCloseTo(40);
    recordFfmpegRead('a.test', 800 * MB, 10_000); // 80 MB/s: 0,7 x 40 + 0,3 x 80
    expect(ffmpegMbpsFor('a.test')).toBeCloseTo(52);
    expect(ffmpegSamplesFor('a.test')).toBe(2);
  });

  it('cada host tem a sua', () => {
    recordFfmpegRead('rapido.test', 1000 * MB, 5_000); // 200 MB/s
    recordFfmpegRead('lento.test', 100 * MB, 20_000); // 5 MB/s
    expect(ffmpegMbpsFor('rapido.test')).toBeCloseTo(200);
    expect(ffmpegMbpsFor('lento.test')).toBeCloseTo(5);
    expect(ffmpegMbpsFor('outro.test')).toBe(config.ffmpegThroughputMbps);
  });

  it('limita amostras absurdas entre 5 e 200 MB/s', () => {
    recordFfmpegRead('x.test', 900 * MB, 600); // 1500 MB/s: cache local, não o CDN
    expect(ffmpegMbpsFor('x.test')).toBe(200);
    resetFfmpegSpeed();
    recordFfmpegRead('y.test', 60 * MB, 600_000); // 0,1 MB/s
    expect(ffmpegMbpsFor('y.test')).toBe(5);
  });

  it('ignora leitura pequena demais, tempo inválido e host vazio', () => {
    expect(recordFfmpegRead('z.test', 10 * MB, 1000)).toBeNull();
    expect(recordFfmpegRead('z.test', 800 * MB, 0)).toBeNull();
    expect(recordFfmpegRead('z.test', NaN, 5000)).toBeNull();
    expect(recordFfmpegRead('', 800 * MB, 5000)).toBeNull();
    expect(ffmpegSamplesFor('z.test')).toBe(0);
  });
});
