import type { CatalogItem } from './catalog';

export type CalendarKind = 'sub' | 'dub';
export interface CalendarEvent {
  key: string;
  anilistId?: number;
  malId?: string;
  route?: string;
  aliases?: string[];
  format?: string;
  donghua?: boolean;
  platforms?: string[];
  popularity?: number;
  totalEpisodes?: number;
  title: string;
  poster?: string;
  episode: number;
  kind: CalendarKind;
  at: string | null;
  delayed: boolean;
  missingTitle: boolean;
}
export interface CalendarData {
  events: CalendarEvent[];
  checkedAt: string;
  updatedAt: string;
  stale: boolean;
  failedSources: string[];
  rangeStart: string;
  rangeEnd: string;
  source?: string;
}
export interface CalendarSource { kind: CalendarKind; schedule: unknown[]; feed: unknown[] }
export interface CalendarMatches {
  matches: Record<string, { malId?: string; anilistId?: number }>;
  incomplete: boolean;
}

export const CALENDAR_FORMATS = ['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL', 'MOVIE', 'OTHER'] as const;
export interface CalendarFilters {
  formats: string[]; showDonghua: boolean; platform: string; sort: 'popularity' | 'time' | 'name';
  kind: 'all' | CalendarKind; prefer: 'all' | CalendarKind; hour12: boolean; showImages: boolean;
}
export const DEFAULT_CALENDAR_FILTERS: CalendarFilters = { formats: ['TV', 'ONA'], showDonghua: false, platform: '', sort: 'popularity', kind: 'all', prefer: 'all', hour12: false, showImages: true };
export function parseCalendarFilters(raw: unknown): CalendarFilters {
  const value = raw as Partial<CalendarFilters> | null;
  if (!value || typeof value !== 'object') return { ...DEFAULT_CALENDAR_FILTERS };
  return {
    formats: Array.isArray(value.formats) ? value.formats.filter(f => CALENDAR_FORMATS.includes(f as typeof CALENDAR_FORMATS[number])) : [...DEFAULT_CALENDAR_FILTERS.formats],
    showDonghua: value.showDonghua === true,
    platform: typeof value.platform === 'string' ? value.platform.slice(0, 60) : '',
    sort: value.sort === 'time' || value.sort === 'name' ? value.sort : 'popularity',
    kind: value.kind === 'sub' || value.kind === 'dub' ? value.kind : 'all',
    prefer: value.prefer === 'sub' || value.prefer === 'dub' ? value.prefer : 'all',
    hour12: value.hour12 === true,
    showImages: value.showImages !== false,
  };
}
export function filterCalendarEvents(events: CalendarEvent[], filters: CalendarFilters, query = ''): CalendarEvent[] {
  const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const q = normalize(query.trim());
  const available = events.filter(event => filters.formats.includes(event.format ?? 'TV')
    && (filters.kind === 'all' || event.kind === filters.kind)
    && (filters.showDonghua || !event.donghua)
    && (!filters.platform || event.platforms?.includes(filters.platform))
    && (!q || [event.title, ...(event.aliases ?? [])].some(title => normalize(title).includes(q))));
  const identity = (event: CalendarEvent) => event.route ? `route:${event.route}` : event.malId ? `mal:${event.malId}` : event.anilistId ? `al:${event.anilistId}` : event.key;
  const preferred = new Set(available.filter(event => event.kind === filters.prefer).map(identity));
  return available.filter(event => filters.prefer === 'all' || event.kind === filters.prefer || !preferred.has(identity(event)))
    .sort((a, b) => filters.sort === 'name' ? a.title.localeCompare(b.title)
      : filters.sort === 'time' ? (a.at ?? '9999').localeCompare(b.at ?? '9999') || a.title.localeCompare(b.title)
      : (b.popularity ?? 0) - (a.popularity ?? 0) || a.title.localeCompare(b.title));
}

/** Adaptador do formato publicado: agenda e histórico têm contratos diferentes. */
export function normalizeCalendar(sources: CalendarSource[]): CalendarEvent[] {
  const metadata = new Map<number, any>();
  for (const source of sources) for (const raw of source.schedule) {
    const m = raw as any;
    if (Number.isInteger(m?.id) && m.id > 0) metadata.set(m.id, m);
  }
  const events = new Map<string, CalendarEvent>();
  const add = (kind: CalendarKind, raw: any, episode: unknown, date: unknown, delayed = false) => {
    if (!Number.isInteger(raw?.id) || raw.id <= 0 || !Number.isInteger(episode) || (episode as number) < 0) return;
    const time = typeof date === 'number' ? date * 1000 : typeof date === 'string' ? Date.parse(date) : NaN;
    const validTime = Number.isFinite(time) && time >= 0 && Number.isFinite(new Date(time).getTime());
    if (!validTime && !delayed) return;
    const m = metadata.get(raw.id) ?? raw;
    const malId = m.idMal ?? raw.idMal;
    const name = m.title?.english || m.title?.romaji || m.title?.native;
    const poster = m.coverImage?.extraLarge || m.coverImage?.medium;
    const key = `${kind}:${raw.id}:${episode}`;
    events.set(key, {
      key, anilistId: raw.id, malId: Number.isInteger(malId) && malId > 0 ? String(malId) : undefined,
      aliases: Object.values(m.title ?? {}).filter((title): title is string => typeof title === 'string'),
      title: typeof name === 'string' ? name.slice(0, 300) : `Anime ${malId ? `MAL ${malId}` : `AniList ${raw.id}`}`,
      poster: typeof poster === 'string' && /^https:\/\//i.test(poster) ? poster.slice(0, 1000) : undefined,
      episode: episode as number, kind, at: validTime ? new Date(time).toISOString() : null,
      delayed, missingTitle: typeof name !== 'string',
    });
  };
  // O agendamento atual prevalece sobre o histórico, inclusive depois de um adiamento.
  for (const source of sources) for (const raw of source.feed as any[]) add(source.kind, raw, raw?.episode?.aired, raw?.episode?.airedAt);
  for (const source of sources) for (const raw of source.schedule as any[]) {
    for (const node of Array.isArray(raw?.airingSchedule?.nodes) ? raw.airingSchedule.nodes : []) {
      add(source.kind, raw, node?.episode, node?.airingAt, !!(node?.delayed || node?.delayedIndefinitely));
    }
  }
  return [...events.values()].sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999') || a.key.localeCompare(b.key));
}

/** Calendário civil local: somar dias, em vez de 24 h, preserva a semana nas mudanças de DST. */
export function calendarWeek(anchor: Date): Date[] {
  const monday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 12);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  return Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i, 12));
}
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function matchCalendarItem(event: CalendarEvent, list: CatalogItem[], resolved: Record<string, string[]>): CatalogItem | undefined {
  return list.find(item => item.type !== 'movie' && event.malId && (item.id === `mal:${event.malId}` || resolved[item.id]?.includes(event.malId)));
}
