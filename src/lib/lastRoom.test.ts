import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// O idioma é decidido ao carregar o módulo de i18n (pelo navegador): sem isto o CI, em inglês, traduz "agoLabel"
vi.hoisted(() => {
  vi.stubGlobal('navigator', { language: 'pt-BR' });
});

import { agoLabel, clearLastRoom, loadLastRoom, saveLastRoom } from './lastRoom';

describe('lastRoom', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('guarda e lê o código e a hora', () => {
    saveLastRoom('ABC12345', 1_000);
    expect(loadLastRoom(2_000)).toEqual({ code: 'ABC12345', at: 1_000 });
    clearLastRoom();
    expect(loadLastRoom()).toBeNull();
  });

  it('o estado da sala chega o tempo todo: na mesma sala só regrava depois do intervalo (ou à força)', () => {
    saveLastRoom('ABC12345', 1_000);
    saveLastRoom('ABC12345', 10_000); // menos de 30 s depois
    expect(loadLastRoom(10_000)!.at).toBe(1_000);
    saveLastRoom('ABC12345', 40_000);
    expect(loadLastRoom(40_000)!.at).toBe(40_000);
    saveLastRoom('ABC12345', 41_000, true); // sair da sala marca a hora exata
    expect(loadLastRoom(41_000)!.at).toBe(41_000);
    saveLastRoom('OUTRA999', 42_000); // outra sala troca de imediato
    expect(loadLastRoom(42_000)!.code).toBe('OUTRA999');
  });

  it('registro com mais de 24 h, código estranho ou JSON quebrado não vale', () => {
    saveLastRoom('ABC12345', 1_000);
    expect(loadLastRoom(1_000 + 24 * 60 * 60 * 1000 + 1)).toBeNull();
    saveLastRoom('abc', 1_000); // minúsculas/curto: nem grava
    saveLastRoom('../x', 1_000);
    expect(loadLastRoom(1_000)!.code).toBe('ABC12345');
    store.set('lunio_last_room', '{nao é json');
    expect(loadLastRoom()).toBeNull();
    store.set('lunio_last_room', JSON.stringify({ code: 'ABC12345', at: 'ontem' }));
    expect(loadLastRoom()).toBeNull();
  });

  it('sem localStorage nada quebra', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('bloqueado');
      },
      removeItem: () => {
        throw new Error('bloqueado');
      },
    });
    expect(() => saveLastRoom('ABC12345')).not.toThrow();
    expect(loadLastRoom()).toBeNull();
    expect(() => clearLastRoom()).not.toThrow();
  });

  it('agoLabel: agora há pouco, minutos, horas', () => {
    expect(agoLabel(20_000)).toBe('agora há pouco');
    expect(agoLabel(5 * 60_000)).toBe('há 5 min');
    expect(agoLabel(3 * 3_600_000 + 10 * 60_000)).toBe('há 3 h');
    expect(agoLabel(-5)).toBe('agora há pouco');
  });
});
