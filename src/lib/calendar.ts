import type { CatalogItem } from './catalog';

export type CalendarKind = 'sub' | 'dub';
export interface CalendarEvent {
  key: string;
  anilistId: number;
  malId?: string;
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
}
export interface CalendarSource { kind: CalendarKind; schedule: unknown[]; feed: unknown[] }

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
