import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactUrlsInText } from '../logRedaction';
import { parseTracks } from '../media/tracks';
import {
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  cooldownRemainingMs,
  hostOf,
  noteRateLimited,
  resetGateForTests,
  runOnHost,
} from '../media/upstreamGate';

/**
 * Legendas de um release com várias línguas: nomes pt-BR / pt-PT, uma extração por vez por host do CDN,
 * espera depois de 429 e nenhum token de URL no log.
 */

describe('português do Brasil x de Portugal', () => {
  // Trecho do ffmpeg -i de um release da Netflix: as duas são "por", só o título muda
  const stderr = [
    'Input #0, matroska,webm, from \'x.mkv\':',
    '  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080',
    '  Stream #0:1(jpn): Audio: aac (LC), 48000 Hz, stereo',
    '  Stream #0:2(eng): Subtitle: ass (ssa)',
    '    Metadata:',
    '      title           : NF_English',
    '  Stream #0:4(por): Subtitle: ass (ssa)',
    '    Metadata:',
    '      title           : NF_Portuguese(Brazil)',
    '  Stream #0:13(por): Subtitle: ass (ssa)',
    '    Metadata:',
    '      title           : NF_Portuguese',
  ].join('\n');

  const titles = (raw: string) => parseTracks(raw, 'https://x.test/a.mkv', 'https://x.test/a.mkv').subtitles.map((s: any) => s.title);

  it('com as duas variantes, cada uma recebe o seu nome e a sua bandeira', () => {
    const t = titles(stderr);
    expect(t).toContain('🇧🇷 Português (Brasil) [Completo]');
    expect(t).toContain('🇵🇹 Português (Portugal) [Completo]');
  });

  it('só uma faixa em português continua "Português" com a bandeira do Brasil', () => {
    const only = [
      '  Stream #0:2(eng): Subtitle: ass (ssa)',
      '    Metadata:',
      '      title           : NF_English',
      '  Stream #0:13(por): Subtitle: ass (ssa)',
      '    Metadata:',
      '      title           : NF_Portuguese',
    ].join('\n');
    const t = titles(only);
    expect(t.filter((x: string) => x.includes('Português'))).toEqual(['🇧🇷 Português [Completo]']);
  });

  it('se o título diz Portugal, a outra sem marca é a do Brasil', () => {
    const swapped = stderr.replace('NF_Portuguese(Brazil)', 'NF_Portuguese').replace(/(Stream #0:13[\s\S]*?title\s+: )NF_Portuguese/, '$1NF_Portuguese(Portugal)');
    const t = titles(swapped);
    expect(t).toContain('🇧🇷 Português (Brasil) [Completo]');
    expect(t).toContain('🇵🇹 Português (Portugal) [Completo]');
  });
});

describe('portão por host do CDN', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGateForTests();
  });
  afterEach(() => vi.useRealTimers());

  it('roda uma extração por vez no mesmo host e em paralelo em hosts diferentes', async () => {
    let running = 0;
    let peak = 0;
    const job = (ms: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
    };
    const a = runOnHost('cdn-a', 'prefetch', job(100)).promise;
    const b = runOnHost('cdn-a', 'prefetch', job(100)).promise;
    await vi.advanceTimersByTimeAsync(250);
    await Promise.all([a, b]);
    expect(peak).toBe(1);

    peak = 0;
    const c = runOnHost('cdn-a', 'prefetch', job(100)).promise;
    const d = runOnHost('cdn-b', 'prefetch', job(100)).promise;
    await vi.advanceTimersByTimeAsync(150);
    await Promise.all([c, d]);
    expect(peak).toBe(2);
  });

  it('o que o usuário pediu passa na frente das pré-extrações que ainda não começaram', async () => {
    const order: string[] = [];
    const job = (name: string) => async () => {
      order.push(name);
      await new Promise((r) => setTimeout(r, 50));
    };
    const first = runOnHost('cdn', 'prefetch', job('em-andamento')).promise;
    const pre = runOnHost('cdn', 'prefetch', job('pre-carga')).promise;
    const user = runOnHost('cdn', 'interactive', job('usuario')).promise;
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([first, pre, user]);
    expect(order).toEqual(['em-andamento', 'usuario', 'pre-carga']);
  });

  it('uma pré-extração promovida (bump) também passa na frente', async () => {
    const order: string[] = [];
    const job = (name: string) => async () => {
      order.push(name);
      await new Promise((r) => setTimeout(r, 50));
    };
    const first = runOnHost('cdn', 'prefetch', job('1')).promise;
    runOnHost('cdn', 'prefetch', job('2'));
    const third = runOnHost('cdn', 'prefetch', job('3'));
    third.bump();
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([first, third.promise]);
    expect(order.slice(0, 2)).toEqual(['1', '3']);
  });

  it('depois de um 429 o host fica em espera antes da próxima extração', async () => {
    noteRateLimited('cdn', 10);
    expect(cooldownRemainingMs('cdn')).toBeGreaterThan(9000);
    let started = false;
    const p = runOnHost('cdn', 'interactive', async () => {
      started = true;
    }).promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000);
    await p;
    expect(started).toBe(true);
  });

  it('o Retry-After tem teto e, sem ele, vale o padrão', () => {
    noteRateLimited('a', 3600);
    expect(cooldownRemainingMs('a')).toBeLessThanOrEqual(MAX_COOLDOWN_MS);
    noteRateLimited('b');
    expect(cooldownRemainingMs('b')).toBeLessThanOrEqual(DEFAULT_COOLDOWN_MS);
    expect(cooldownRemainingMs('b')).toBeGreaterThan(DEFAULT_COOLDOWN_MS - 1000);
  });

  it('uma extração que falha não trava a fila', async () => {
    const bad = runOnHost('cdn', 'prefetch', async () => {
      throw new Error('falhou');
    }).promise;
    const good = runOnHost('cdn', 'prefetch', async () => 'ok').promise;
    await expect(bad).rejects.toThrow('falhou');
    await expect(good).resolves.toBe('ok');
  });

  it('hostOf', () => {
    expect(hostOf('https://wormhole-001.weur.tb-cdn.st/dld/abc?token=x')).toBe('wormhole-001.weur.tb-cdn.st');
    expect(hostOf('não é url')).toBe('desconhecido');
  });
});

describe('tokens fora do log', () => {
  const secret = '10e0dec7-7a39-4a10-b311-0701889e27ee';

  it('URL com token no caminho ou na query vira só o host', () => {
    const out = redactUrlsInText(
      `Error opening input file https://wormhole-001.weur.tb-cdn.st/dld/af18?token=${secret}.\n` +
        `origem https://torrentio.strem.fun/resolve/torbox/${secret}/hash/arquivo.mkv/0/arquivo.mkv falhou`
    );
    expect(out).not.toContain(secret);
    expect(out).toContain('https://wormhole-001.weur.tb-cdn.st/…');
    expect(out).toContain('https://torrentio.strem.fun/…');
  });

  it('URLs sem caminho e textos comuns ficam intactos', () => {
    expect(redactUrlsInText('Servidor em http://localhost:3000')).toBe('Servidor em http://localhost:3000');
    expect(redactUrlsInText('[Subtitle] Faixa #4 extraída em 21.8s')).toBe('[Subtitle] Faixa #4 extraída em 21.8s');
  });

  it('o console passa a redigir (inclusive Error)', async () => {
    const { installLogRedaction } = await import('../logRedaction');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installLogRedaction();
    console.warn('[x] falha', `https://cdn.test/dld/abc?token=${secret}`, new Error(`abrindo https://cdn.test/a/${secret}`));
    const printed = spy.mock.calls.flat().join(' ');
    expect(printed).not.toContain(secret);
    expect(printed).toContain('https://cdn.test/…');
    spy.mockRestore();
  });
});
