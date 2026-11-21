import { describe, expect, it } from 'vitest';
import { ServerClock } from './serverClock';

/** Relógio do servidor `skew` ms à frente (ou atrás, se negativo) do `Date.now()` deste computador. */
function rig(skew: number) {
  let mono = 1_000;
  const wall = 1_700_000_000_000;
  const clock = new ServerClock(() => mono, () => wall + mono);
  const serverAt = (m: number) => wall + m + skew;
  /** Um heartbeat: `out` ms para ir, `back` ms para voltar. */
  const ping = (out: number, back: number) => {
    const t0 = mono;
    mono += out;
    const serverTime = serverAt(mono);
    mono += back;
    clock.add(t0, mono, serverTime);
  };
  return { clock, ping, advance: (ms: number) => (mono += ms), serverNow: () => serverAt(mono) };
}

describe('ServerClock', () => {
  it('antes de medir, usa o relógio do próprio computador', () => {
    const { clock } = rig(0);
    expect(clock.synced).toBe(false);
    expect(clock.now()).toBe(1_700_000_000_000 + 1_000);
  });

  it('acerta a hora do servidor mesmo com o relógio daqui 90 s atrasado', () => {
    const { clock, ping, serverNow, advance } = rig(90_000);
    ping(30, 30);
    advance(5_000);
    expect(Math.abs(clock.now() - serverNow())).toBeLessThanOrEqual(1);
  });

  it('acerta com o relógio daqui adiantado', () => {
    const { clock, ping, serverNow } = rig(-120_000);
    ping(40, 40);
    expect(Math.abs(clock.now() - serverNow())).toBeLessThanOrEqual(1);
  });

  it('prefere a medição de menor ida e volta (a assimetria da rede erra menos)', () => {
    const { clock, ping, serverNow } = rig(5_000);
    ping(30, 30); // exata
    ping(400, 40); // ida lenta: erraria 180 ms
    expect(clock.rtt).toBe(60);
    expect(Math.abs(clock.now() - serverNow())).toBeLessThanOrEqual(1);
  });

  it('só guarda as últimas 8 medições', () => {
    const { clock, ping } = rig(0);
    ping(10, 10); // a melhor, que sai da janela
    for (let i = 0; i < 8; i++) ping(100, 100);
    expect(clock.rtt).toBe(200);
  });

  it('ignora medição impossível e volta ao relógio daqui com reset', () => {
    const { clock, ping } = rig(0);
    clock.add(500, 100, 123);
    clock.add(0, 10, Number.NaN);
    expect(clock.synced).toBe(false);
    ping(20, 20);
    expect(clock.synced).toBe(true);
    clock.reset();
    expect(clock.synced).toBe(false);
  });
});
