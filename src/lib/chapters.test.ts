import { describe, expect, it } from 'vitest';
import { isEndingChapter, shouldShowNextEpisodePrompt } from './chapters';
import type { Chapter } from '../types/media';

describe('isEndingChapter', () => {
  it('reconhece variações de ED/Ending/Encerramento/Outro', () => {
    for (const title of ['ED', 'ED 1', 'ED: Ending', 'Ending', 'Ending Theme', 'Encerramento', 'Outro']) {
      expect(isEndingChapter({ startTime: 1200, endTime: 1290, title })).toBe(true);
    }
    for (const title of ['OP', 'Opening', 'Episódio', 'Part 01', 'Preview', 'Créditos iniciais', 'Outro mundo', 'O outro lado', 'Outro exemplo']) {
      expect(isEndingChapter({ startTime: 0, endTime: 90, title })).toBe(false);
    }
  });
});

describe('shouldShowNextEpisodePrompt', () => {
  const animeChapters: Chapter[] = [
    { startTime: 0, endTime: 90, title: 'OP' },
    { startTime: 90, endTime: 1320, title: 'Part A' },
    { startTime: 1320, endTime: 1410, title: 'ED' },
  ];

  it('mostra o cartão assim que entra no capítulo de encerramento (mesmo faltando 1:30)', () => {
    expect(shouldShowNextEpisodePrompt(1319.5, 1440, animeChapters)).toBe(false);
    expect(shouldShowNextEpisodePrompt(1320, 1440, animeChapters)).toBe(true);
    expect(shouldShowNextEpisodePrompt(1360, 1440, animeChapters)).toBe(true);
  });

  it('quando não há capítulo de encerramento, usa o fallback dos últimos 15 s', () => {
    const noEd: Chapter[] = [
      { startTime: 0, endTime: 90, title: 'OP' },
      { startTime: 90, endTime: 1440, title: 'Episode' },
    ];
    expect(shouldShowNextEpisodePrompt(1424, 1440, noEd)).toBe(false);
    expect(shouldShowNextEpisodePrompt(1425, 1440, noEd)).toBe(true);
    expect(shouldShowNextEpisodePrompt(1425, 1440, [])).toBe(true);
  });

  it('não dispara fallback em vídeos curtos (<= 30 s) sem capítulo de encerramento', () => {
    expect(shouldShowNextEpisodePrompt(25, 30, [])).toBe(false);
  });
});
