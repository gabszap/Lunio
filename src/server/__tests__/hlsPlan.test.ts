import { describe, expect, it } from 'vitest';
import { buildPlan, buildPlaylist, segmentCount, segmentDuration } from '../media/hlsPlan';

describe('plano de segmentos HLS', () => {
  it('escolhe keyframes com ~6 s de distância e fecha com a duração', () => {
    const keyframes = Array.from({ length: 31 }, (_, i) => i); // keyframe a cada 1 s, 0..30
    const plan = buildPlan(keyframes, 30.5);
    expect(plan.boundaries).toEqual([0, 6, 12, 18, 24, 30.5]); // o keyframe de 30 sobra < 1 s: junta ao último
    expect(plan.boundaries[0]).toBe(0);
    expect(plan.boundaries.at(-1)).toBe(30.5);
    for (let i = 0; i < segmentCount(plan) - 1; i++) expect(segmentDuration(plan, i)).toBeGreaterThanOrEqual(5.75);
  });

  it('todo limite é um keyframe (menos o fim)', () => {
    const keyframes = [0, 2.5, 7.1, 11.9, 14.2, 20.4, 26.8];
    const plan = buildPlan(keyframes, 30);
    for (const b of plan.boundaries.slice(0, -1)) expect(keyframes).toContain(b);
    expect(plan.boundaries.at(-1)).toBe(30);
  });

  it('com GOP longo (10 s) os segmentos seguem o GOP, sem cortar fora de keyframe', () => {
    const plan = buildPlan([0, 10, 20, 30, 40], 45);
    expect(plan.boundaries).toEqual([0, 10, 20, 30, 40, 45]);
  });

  it('ignora keyframe colado no seguinte (o -ss poderia cair no vizinho)', () => {
    const plan = buildPlan([0, 6, 6.1, 12, 18], 24);
    expect(plan.boundaries).not.toContain(6);
    expect(plan.boundaries).toContain(6.1);
  });

  it('junta um rabinho final menor que 1 s ao segmento anterior', () => {
    const plan = buildPlan([0, 6, 12, 18], 18.4);
    expect(plan.boundaries).toEqual([0, 6, 12, 18.4]);
  });

  it('sem keyframes úteis vira um segmento só; ignora lixo e valores fora da duração', () => {
    expect(buildPlan([], 20).boundaries).toEqual([0, 20]);
    expect(buildPlan([NaN, -3, 99, 5], 20).boundaries).toEqual([0, 20]);
  });

  it('a playlist é VOD, tem EXTINF por segmento e leva o token em cada segmento', () => {
    const plan = buildPlan([0, 6, 12], 15);
    const text = buildPlaylist(plan, '?t=abc%2B');
    expect(text.startsWith('#EXTM3U')).toBe(true);
    expect(text).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(text).toContain('#EXT-X-ENDLIST');
    expect(text).toContain('#EXT-X-TARGETDURATION:6');
    expect(text).toContain('#EXTINF:6.000,\n0.ts?t=abc%2B');
    expect(text).toContain('#EXTINF:3.000,\n2.ts?t=abc%2B');
    expect((text.match(/#EXTINF/g) || []).length).toBe(3);
    // soma das durações = duração total
    const sum = [...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((s, m) => s + Number(m[1]), 0);
    expect(sum).toBeCloseTo(15, 3);
  });
});
