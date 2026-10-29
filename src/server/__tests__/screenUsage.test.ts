import { beforeEach, describe, expect, it } from 'vitest';
import { getScreenUsage, recordScreenUsage, resetScreenUsageForTests } from '../screenUsage';

describe('screenUsage', () => {
  beforeEach(() => resetScreenUsageForTests());

  it('soma os bytes do Host e a saída estimada (bytes x espectadores)', () => {
    recordScreenUsage(1000, 3);
    recordScreenUsage(500, 0);
    const u = getScreenUsage();
    expect(u.hostBytes).toBe(1500);
    expect(u.estimatedEgressBytes).toBe(3000);
    expect(u.since).toBeGreaterThan(0);
  });

  it('ignora valores negativos, NaN e infinitos', () => {
    recordScreenUsage(-1, 2);
    recordScreenUsage(NaN, 2);
    recordScreenUsage(Infinity, 2);
    recordScreenUsage(100, -1);
    recordScreenUsage(100, NaN);
    expect(getScreenUsage()).toMatchObject({ hostBytes: 0, estimatedEgressBytes: 0 });
  });

  it('sem Redis a chamada não lança e já contou na hora', () => {
    expect(() => recordScreenUsage(10, 1)).not.toThrow();
    expect(getScreenUsage().hostBytes).toBe(10);
  });

  it('zera para os testes', () => {
    recordScreenUsage(10, 1);
    resetScreenUsageForTests();
    expect(getScreenUsage()).toMatchObject({ hostBytes: 0, estimatedEgressBytes: 0 });
  });
});
