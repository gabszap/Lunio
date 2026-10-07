import { Chapter } from '../types/media';
import { t } from './/i18n';

export function normalizeChapters(chapters: Chapter[], totalDuration: number = 0): Chapter[] {
  if (!chapters || chapters.length === 0) return [];

  const sorted = [...chapters].sort((a, b) => a.startTime - b.startTime);

  return sorted.map((chap, idx) => {
    let endTime = chap.endTime;
    if (endTime === undefined || endTime <= chap.startTime) {
      if (idx < sorted.length - 1) {
        endTime = sorted[idx + 1].startTime;
      } else if (totalDuration > chap.startTime) {
        endTime = totalDuration;
      } else {
        endTime = chap.startTime + 60; // fallback duration
      }
    }
    return {
      ...chap,
      endTime,
    };
  });
}

export function getCurrentChapter(currentTime: number, chapters: Chapter[]): Chapter | null {
  if (!chapters || chapters.length === 0) return null;

  for (let i = chapters.length - 1; i >= 0; i--) {
    const c = chapters[i];
    if (currentTime >= c.startTime) {
      if (c.endTime === undefined || currentTime <= c.endTime) {
        return c;
      }
    }
  }

  return chapters[0] ?? null;
}

export interface SkippableChapterInfo {
  canSkip: boolean;
  label: string;
  type: 'op' | 'ed' | 'recap' | 'preview';
  targetTime: number;
}

export function isOpeningChapter(chapter: Chapter | null): boolean {
  if (!chapter || !chapter.title) return false;
  const title = chapter.title.trim().toLowerCase();
  return (
    /^(op|opening|abertura|intro)(\s*\d+)?$/i.test(title) ||
    /\b(opening\s+theme|tema\s+de\s+abertura|abertura|intro)\b/i.test(title) ||
    title === 'op' ||
    title.startsWith('op ') ||
    title.startsWith('op:') ||
    title.startsWith('op-')
  );
}

export function getSkippableChapter(currentTime: number, chapters: Chapter[]): SkippableChapterInfo | null {
  if (!chapters || chapters.length === 0) return null;

  // Procura o capítulo que engloba currentTime com margem de segurança de 1.5s antes do término
  const current = chapters.find(
    (c) => currentTime >= c.startTime && (c.endTime === undefined || currentTime < c.endTime - 1.5)
  );

  if (!current || !current.title || !current.endTime || current.endTime <= current.startTime) {
    return null;
  }

  const title = current.title.trim().toLowerCase();

  // Abertura / Opening
  if (
    /^(op|opening|abertura|intro)(\s*\d+)?$/i.test(title) ||
    /\b(opening\s+theme|tema\s+de\s+abertura|abertura|intro)\b/i.test(title) ||
    title === 'op' ||
    title.startsWith('op ') ||
    title.startsWith('op:') ||
    title.startsWith('op-')
  ) {
    return {
      canSkip: true,
      label: t('Pular abertura'),
      type: 'op',
      targetTime: current.endTime,
    };
  }

  // Encerramento / Ending
  if (
    /^(ed|ending|encerramento|outro)(\s*\d+)?$/i.test(title) ||
    /\b(ending\s+theme|tema\s+de\s+encerramento|encerramento|outro)\b/i.test(title) ||
    title === 'ed' ||
    title.startsWith('ed ') ||
    title.startsWith('ed:') ||
    title.startsWith('ed-')
  ) {
    return {
      canSkip: true,
      label: t('Pular encerramento'),
      type: 'ed',
      targetTime: current.endTime,
    };
  }

  // Recap / Resumo
  if (
    /^(recap|resumo|previamente|previously)(\s*\d+)?$/i.test(title) ||
    /\b(recapitulando|resumo\s+anterior|previously\s+on)\b/i.test(title)
  ) {
    return {
      canSkip: true,
      label: t('Pular resumo'),
      type: 'recap',
      targetTime: current.endTime,
    };
  }

  return null;
}

export function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}
