import { describe, expect, it } from 'vitest';
import { getDriftPlaybackRate } from './playbackDrift';

describe('velocidade do espectador', () => {
  it('corrige em torno da velocidade do Host e volta à nominal quando converge', () => {
    const nominal = 1.5;
    expect(getDriftPlaybackRate('rate_slowdown', nominal)).toBeCloseTo(1.275);
    expect(getDriftPlaybackRate('rate_speedup', nominal)).toBeCloseTo(1.62);
    expect(getDriftPlaybackRate('none', nominal)).toBe(nominal);
  });
});
