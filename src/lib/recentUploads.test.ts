import { describe, expect, it } from 'vitest';
import { describeExpiry } from './recentUploads';

const MIN = 60_000;

describe('describeExpiry', () => {
  const now = 1_000_000_000_000;

  it('sem prazo conhecido não inventa um', () => {
    expect(describeExpiry(null, now)).toBeNull();
    expect(describeExpiry(undefined, now)).toBeNull();
  });

  it('1 h ou mais conta em horas (arredonda para baixo) e anda com o tempo', () => {
    const exp = now + 5 * 60 * MIN + 59 * MIN;
    expect(describeExpiry(exp, now)).toEqual({ unit: 'h', value: 5 });
    expect(describeExpiry(exp, now + 60 * MIN)).toEqual({ unit: 'h', value: 4 });
    expect(describeExpiry(exp, now + 5 * 60 * MIN)).toEqual({ unit: 'min', value: 59 });
  });

  it('abaixo de 1 h conta em minutos, e no fim (ou vencido) diz que é agora', () => {
    expect(describeExpiry(now + 59 * MIN + 30_000, now)).toEqual({ unit: 'min', value: 59 });
    expect(describeExpiry(now + 90_000, now)).toEqual({ unit: 'min', value: 1 });
    expect(describeExpiry(now + 30_000, now)).toEqual({ unit: 'now', value: 0 });
    expect(describeExpiry(now - 5 * MIN, now)).toEqual({ unit: 'now', value: 0 });
  });
});
