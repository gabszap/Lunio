/**
 * Histórico de streams recentes e limpeza de títulos de release.
 */

export interface RecentStream {
  url: string;
  title: string;
  date: string;
}

const RECENT_KEY = 'streamplayer_recent_streams';

export function loadRecentStreams(): RecentStream[] {
  try {
    const saved = localStorage.getItem(RECENT_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

export function saveRecentStreams(list: RecentStream[]) {
  try {
    if (list.length === 0) localStorage.removeItem(RECENT_KEY);
    else localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // armazenamento indisponível
  }
}

export function pushRecentStream(list: RecentStream[], url: string, title: string): RecentStream[] {
  if (!url || !url.trim()) return list;
  const updated = [
    {
      url,
      title: title || url.split('/').pop()?.split('?')[0] || 'Stream',
      date: new Date().toLocaleDateString('pt-BR'),
    },
    ...list.filter((item) => item.url !== url),
  ].slice(0, 10);
  saveRecentStreams(updated);
  return updated;
}

export function extractCleanTitleFromUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr, window.location.origin);
    const parts = parsed.pathname.split('/').map((p) => {
      try {
        let dec = decodeURIComponent(p);
        if (dec.includes('%')) {
          try {
            dec = decodeURIComponent(dec);
          } catch {}
        }
        return dec;
      } catch {
        return p;
      }
    });

    const mediaPart = parts.slice().reverse().find((p) => /\.(mkv|mp4|avi|webm|mov|m4v|ts)$/i.test(p));
    const raw = mediaPart || parts.filter(Boolean).pop() || '';
    if (raw) {
      return raw.replace(/\.[a-z0-9]+$/i, '').trim();
    }
  } catch {}
  return '';
}

export function formatRecentTitle(rawTitle: string): { epTag: string; cleanName: string } {
  if (!rawTitle) return { epTag: 'Stream', cleanName: 'Vídeo' };

  const normalized = rawTitle.replace(/\./g, ' ');

  // Padrões como S01E02, S2E5, 2x01, E02, EP02
  const epMatch = normalized.match(/\b(S\d{1,2}E\d{1,2}|\d{1,2}x\d{1,2}|EP?\s*\d{1,3})\b/i);
  const epTag = epMatch ? epMatch[1].toUpperCase().replace(/\s+/, '') : '';

  // Remove tags e ruídos comuns de releases
  let clean = rawTitle
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(1080p|720p|4k|2160p|hevc|x265|x264|av1|web-dl|bdrip|custom|multi|bluray|remux)\b/gi, '')
    .replace(/\b(S\d{1,2}E\d{1,2}|\d{1,2}x\d{1,2})\b/gi, '')
    .replace(/[-_.]+/g, ' ')
    .trim();

  clean = clean.replace(/\s{2,}/g, ' ');

  return {
    epTag: epTag || 'FILME',
    cleanName: clean || rawTitle.slice(0, 35),
  };
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i >= 3 ? 1 : 0).replace('.', ',')} ${units[i]}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
