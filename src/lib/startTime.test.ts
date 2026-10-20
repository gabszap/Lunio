import { describe, expect, it } from 'vitest';
import { parseStartTime } from './startTime';

describe('parseStartTime', () => {
  it('aceita segundos, 1m30s, 1h2m3s e relógio', () => {
    expect(parseStartTime('90')).toBe(90);
    expect(parseStartTime('90s')).toBe(90);
    expect(parseStartTime('1m30s')).toBe(90);
    expect(parseStartTime('2m')).toBe(120);
    expect(parseStartTime('1h2m3s')).toBe(3723);
    expect(parseStartTime('1:30')).toBe(90);
    expect(parseStartTime('1:02:03')).toBe(3723);
    expect(parseStartTime(' 1M30S ')).toBe(90);
  });

  it('descarta o que não é tempo', () => {
    for (const bad of [null, undefined, '', 'abc', '-5', '1:99', '1::2', 'h', 'm30', '1h2x', '99999999', 'NaN', '1e3']) {
      expect(parseStartTime(bad)).toBeNull();
    }
  });
});
