import { describe, expect, it } from 'vitest';
import type { StreamCodecs } from './streamInfo';
import { classifyStream, detectBrowserSupport, type BrowserSupport } from './streamPlayability';

const none: BrowserSupport = { hevc: false, av1: false, ac3: false, eac3: false };
const codecs = (over: Partial<StreamCodecs> = {}): StreamCodecs => ({ videoCodec: 'h264', dolbyVision: false, audio: [], ...over });
const classify = (c: StreamCodecs, support = none, extra: { notWebReady?: boolean; needsProxyHeaders?: boolean } = {}) =>
  classifyStream({ codecs: c, needsProxyHeaders: false, ...extra }, support);

describe('classifyStream', () => {
  it('H.264 com AAC toca', () => {
    expect(classify(codecs({ audio: ['aac'] }))).toEqual({ level: 'ok', reasons: [] });
  });

  it('H.264 sem informação de áudio toca', () => {
    expect(classify(codecs()).level).toBe('ok');
  });

  it('HEVC sem suporte pode falhar; com suporte toca', () => {
    expect(classify(codecs({ videoCodec: 'hevc' }))).toEqual({ level: 'maybe', reasons: ['hevc'] });
    expect(classify(codecs({ videoCodec: 'hevc' }), { ...none, hevc: true }).level).toBe('ok');
  });

  it('AV1 sem suporte pode falhar', () => {
    expect(classify(codecs({ videoCodec: 'av1' }))).toEqual({ level: 'maybe', reasons: ['av1'] });
  });

  it('não pronto para a web ou com cabeçalhos de proxy não toca', () => {
    expect(classify(codecs(), none, { notWebReady: true }).level).toBe('no');
    expect(classify(codecs(), none, { needsProxyHeaders: true }).level).toBe('no');
  });

  it('Dolby Vision sempre pode falhar, mesmo com HEVC suportado', () => {
    expect(classify(codecs({ videoCodec: 'hevc', dolbyVision: true }), { ...none, hevc: true })).toEqual({
      level: 'maybe',
      reasons: ['dolby_vision'],
    });
  });

  it('áudio sem codec tocável pode falhar; com um tocável toca', () => {
    expect(classify(codecs({ audio: ['truehd', 'dts'] }))).toEqual({ level: 'maybe', reasons: ['audio'] });
    expect(classify(codecs({ audio: ['truehd', 'aac'] })).level).toBe('ok');
    expect(classify(codecs({ audio: ['ac3'] })).level).toBe('maybe');
    expect(classify(codecs({ audio: ['ac3'] }), { ...none, ac3: true }).level).toBe('ok');
    expect(classify(codecs({ audio: ['eac3'] }), { ...none, eac3: true }).level).toBe('ok');
  });

  it('vídeo desconhecido pode falhar', () => {
    expect(classify(codecs({ videoCodec: undefined }))).toEqual({ level: 'maybe', reasons: ['unknown'] });
  });

  it('lista todos os motivos que valeram', () => {
    expect(classify(codecs({ videoCodec: 'hevc', dolbyVision: true, audio: ['dts'] })).reasons).toEqual(['hevc', 'dolby_vision', 'audio']);
  });
});

describe('detectBrowserSupport', () => {
  it('ambiente sem suporte: tudo falso', async () => {
    expect(await detectBrowserSupport({ canPlayType: () => '' })).toEqual(none);
  });

  it('lê HEVC do canPlayType', async () => {
    const support = await detectBrowserSupport({ canPlayType: (ct) => (ct.includes('hvc1') ? 'probably' : '') });
    expect(support).toEqual({ ...none, hevc: true });
  });

  it('lê AC-3 e E-AC-3', async () => {
    const support = await detectBrowserSupport({ canPlayType: (ct) => (ct.includes('ac-3') || ct.includes('ec-3') ? 'maybe' : '') });
    expect(support).toEqual({ ...none, ac3: true, eac3: true });
  });

  it('sem navegador (Node) devolve tudo falso sem lançar', async () => {
    expect(await detectBrowserSupport()).toEqual(none);
  });
});
