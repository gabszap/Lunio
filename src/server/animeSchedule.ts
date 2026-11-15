import { parse } from 'parse5';
import { BoundedCache } from './cache';
import type { CalendarData, CalendarEvent, CalendarMatches } from '../lib/calendar';

type HtmlNode = { nodeName: string; tagName?: string; attrs?: { name: string; value: string }[]; value?: string; childNodes?: HtmlNode[] };
export interface ScheduleIdentity { malId?: string; anilistId?: number }
const attr = (n: HtmlNode, key: string) => n.attrs?.find(a => a.name === key)?.value ?? '';
const hasClass = (n: HtmlNode, name: string) => attr(n, 'class').split(/\s+/).includes(name);
const text = (n: HtmlNode): string => n.value ?? (n.childNodes ?? []).map(text).join('');
function nodes(root: HtmlNode, matches: (node: HtmlNode) => boolean): HtmlNode[] {
  const found: HtmlNode[] = [];
  const visit = (node: HtmlNode) => { if (matches(node)) found.push(node); for (const child of node.childNodes ?? []) visit(child); };
  visit(root);
  return found;
}
const routeValid = (route: string) => route.length <= 240 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route);

/** Lê o registro marcado como Sub/Dub, nunca infere um atraso a partir do horário Raw. */
export function parseTimetable(html: string): CalendarEvent[] {
  return timetableFromDocument(parse(html, { scriptingEnabled: false }) as HtmlNode);
}
function timetableFromDocument(doc: HtmlNode): CalendarEvent[] {
  const timetable = nodes(doc, node => attr(node, 'id') === 'timetable')[0];
  if (!timetable) throw new Error('AnimeSchedule: grade ausente');
  const result = new Map<string, CalendarEvent>();
  for (const tile of nodes(timetable, node => hasClass(node, 'timetable-column-show'))) {
    const typeNode = nodes(tile, node => attr(node, 'data-air-type') !== '')[0];
    const kind = typeNode && attr(typeNode, 'data-air-type');
    if (kind !== 'sub' && kind !== 'dub') continue;
    const route = attr(tile, 'data-route');
    if (!routeValid(route)) continue;
    const titleNode = nodes(tile, node => hasClass(node, 'show-title-bar'))[0];
    const title = titleNode ? text(titleNode).replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (!title) continue;
    const timeNode = nodes(tile, node => node.tagName === 'time' && hasClass(node, 'show-air-time'))[0];
    const rawTime = timeNode ? attr(timeNode, 'datetime') : '';
    // Um horário sem offset não identifica um instante e não deve ser convertido pelo fuso do servidor.
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(rawTime) || !Number.isFinite(Date.parse(rawTime))) continue;
    const last = Number(attr(tile, 'data-aired-episode'));
    const lower = Number(attr(tile, 'data-aired-episode-low'));
    if (!Number.isInteger(last) || last < 0) continue;
    const first = Number.isInteger(lower) && lower > 0 && lower <= last ? lower : last;
    if (last - first > 100) continue;
    const image = nodes(tile, node => node.tagName === 'img' && hasClass(node, 'show-poster') && /^https:\/\//.test(attr(node, 'src')))[0];
    const poster = image && attr(image, 'src');
    const rawTypes = attr(tile, 'data-media-types').split(/[\s,]+/);
    const types = rawTypes.map(type => type.replace(/-chinese$/, ''));
    const format = types.includes('tv-short') ? 'TV_SHORT' : types.some(t => t.startsWith('ona')) ? 'ONA' : types.includes('tv') ? 'TV' : types[0]?.toUpperCase() || 'OTHER';
    const platforms = [...new Set(nodes(tile, node => node.tagName === 'a' && hasClass(node, 'stream-link')).map(node => attr(node, 'title')).filter(Boolean))];
    const delayed = nodes(tile, node => hasClass(node, 'show-delay-bar')).some(node => text(node).trim().length > 0);
    const popularity = Number(attr(tile, 'data-popularity'));
    const totalEpisodes = Number(attr(tile, 'data-episodes'));
    for (let episode = first; episode <= last; episode++) {
      const key = `${kind}:${route}:${episode}`;
      result.set(key, { key, route, title, poster: poster && /^https:\/\//.test(poster) ? poster : undefined,
        episode, kind, at: new Date(rawTime).toISOString(), delayed, missingTitle: false,
        format, donghua: attr(tile, 'data-chinese') === 'true' || rawTypes.some(t => t.includes('chinese')),
        platforms, popularity: Number.isFinite(popularity) ? popularity : 0, totalEpisodes: Number.isFinite(totalEpisodes) ? totalEpisodes : undefined });
    }
  }
  return [...result.values()].sort((a, b) => a.at!.localeCompare(b.at!) || a.key.localeCompare(b.key));
}

export function parseScheduleIdentity(html: string): ScheduleIdentity {
  const identity: ScheduleIdentity = {};
  for (const link of nodes(parse(html) as HtmlNode, node => node.tagName === 'a')) {
    const href = attr(link, 'href');
    const mal = /^(?:https?:)?\/\/(?:www\.)?myanimelist\.net\/anime\/(\d+)(?:\/|$)/i.exec(href);
    const al = /^(?:https?:)?\/\/(?:www\.)?anilist\.co\/anime\/(\d+)(?:\/|$)/i.exec(href);
    if (mal && hasClass(link, 'myanimelist-link')) identity.malId = mal[1];
    if (al && hasClass(link, 'anilist-link')) identity.anilistId = Number(al[1]);
  }
  return identity;
}

export function isoWeek(day: string): { year: number; week: number } {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = date.getUTCFullYear();
  const yearStart = Date.parse(`${String(year).padStart(4, '0')}-01-01T00:00:00Z`);
  const week = Math.ceil((((date.getTime() - yearStart) / 86400_000) + 1) / 7);
  return { year, week };
}

function weekMonday(year: number, week: number): string | null {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(week) || week < 1 || week > 53) return null;
  const day = new Date(`${String(year).padStart(4, '0')}-01-04T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7 + (week - 1) * 7);
  const key = day.toISOString().slice(0, 10);
  const actual = isoWeek(key);
  return actual.year === year && actual.week === week ? key : null;
}
function navigationFromDocument(doc: HtmlNode, year: number, week: number): NonNullable<CalendarData['navigation']> {
  const wrapper = nodes(doc, node => attr(node, 'id') === 'timetable-wrapper')[0];
  if (wrapper && (Number(attr(wrapper, 'data-year')) !== year || Number(attr(wrapper, 'data-week')) !== week)) throw new Error('AnimeSchedule: semana divergente');
  const current = weekMonday(year, week)!;
  const link = (id: string, direction: number): string | null => {
    const node = nodes(doc, node => node.tagName === 'a' && attr(node, 'id') === id)[0];
    if (!node || !attr(node, 'href')) return null;
    try {
      const url = new URL(attr(node, 'href'), 'https://animeschedule.net/');
      if (url.origin !== 'https://animeschedule.net' || url.pathname !== '/') return null;
      const target = weekMonday(Number(url.searchParams.get('year')), Number(url.searchParams.get('week')));
      return target && Date.parse(target) - Date.parse(current) === direction * 7 * 86400_000 ? target : null;
    } catch { return null; }
  };
  return { current, previous: link('previous-week-link', -1), next: link('next-week-link', 1) };
}

export function validCalendarQuery(day: string, timezone: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number(day.slice(0, 4)) < 1 || !/^[A-Za-z0-9_+\-/]+$/.test(timezone) || timezone.length > 80) return false;
  const date = new Date(`${day}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); return true; } catch { return false; }
}

type ReadHtml = (path: string, timezone: string) => Promise<string>;
let activeRequests = 0;
const queue: Array<() => void> = [];
async function readHtml(path: string, timezone: string): Promise<string> {
  if (activeRequests >= 3) await new Promise<void>(resolve => queue.push(resolve));
  activeRequests++;
  try {
    const response = await fetch(`https://animeschedule.net${path}`, { redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'text/html', Cookie: `as_timezone=${timezone}`, 'User-Agent': 'LunioCalendar/0.1' } });
    if (!response.ok || !response.body) throw new Error(`AnimeSchedule ${response.status}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 12 * 1024 * 1024) throw new Error('AnimeSchedule: resposta muito grande');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString('utf8');
  } finally { activeRequests--; queue.shift()?.(); }
}

export function createAnimeScheduleService(read: ReadHtml = readHtml, now = () => Date.now()) {
  const cache = new BoundedCache<{ data: CalendarData; at: number; retryAt: number }>(48, 24 * 3600_000, now);
  const identities = new BoundedCache<ScheduleIdentity>(600, 24 * 3600_000, now);
  const matchCursors = new BoundedCache<number>(48, 24 * 3600_000, now);
  const inflight = new Map<string, Promise<CalendarData>>();
  const identityInflight = new Map<string, Promise<ScheduleIdentity>>();
  async function identity(route: string): Promise<ScheduleIdentity> {
    if (!routeValid(route)) throw new Error('bad_route');
    const cached = identities.get(route);
    if (cached) return cached;
    let promise = identityInflight.get(route);
    if (!promise) {
      promise = read(`/anime/${route}`, 'UTC').then(parseScheduleIdentity).then(result => {
        if (!result.malId && !result.anilistId) throw new Error('Identidade ausente');
        identities.set(route, result);
        return result;
      }).finally(() => identityInflight.delete(route));
      identityInflight.set(route, promise);
    }
    return promise;
  }
  async function get(day: string, timezone: string): Promise<CalendarData> {
    const { year, week } = isoWeek(day);
    const key = `${year}:${week}:${timezone}`;
    const hit = cache.get(key);
    const time = now();
    if (hit && time < hit.retryAt) return hit.data;
    let promise = inflight.get(key);
    if (!promise) {
      promise = (async () => {
        try {
          const doc = parse(await read(`/?year=${year}&week=${week}`, timezone), { scriptingEnabled: false }) as HtmlNode;
          const events = timetableFromDocument(doc);
          const navigation = navigationFromDocument(doc, year, week);
          if (!events.length && !nodes(doc, node => attr(node, 'id') === 'timetable-wrapper').length) throw new Error('Agenda sem registros ou navegação');
          const data: CalendarData = { events, source: 'AnimeSchedule.net', stale: false, failedSources: [], checkedAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString(),
            navigation, rangeStart: `${navigation.previous ?? navigation.current}T00:00:00.000Z`, rangeEnd: new Date(Date.parse(navigation.next ?? navigation.current) + 7 * 86400_000 - 1).toISOString() };
          cache.set(key, { data, at: time, retryAt: time + 15 * 60_000 });
          return data;
        } catch (error) {
          if (!hit || time - hit.at > 24 * 3600_000) throw error;
          const data = { ...hit.data, stale: true, failedSources: ['AnimeSchedule.net'] };
          cache.set(key, { ...hit, data, retryAt: time + 60_000 });
          return data;
        }
      })().finally(() => inflight.delete(key));
      inflight.set(key, promise);
    }
    return promise;
  }
  async function match(day: string, timezone: string, malIds: string[]): Promise<CalendarMatches> {
    if (!malIds.length) return { matches: {}, incomplete: false };
    const data = await get(day, timezone);
    const wanted = new Set(malIds);
    const matches: Record<string, ScheduleIdentity> = {};
    const routes = [...new Set(data.events.map(event => event.route!))];
    if (!routes.length) return { matches, incomplete: false };
    const { year, week } = isoWeek(day);
    const cursorKey = `${year}:${week}:${timezone}`;
    const cursor = (matchCursors.get(cursorKey) ?? 0) % routes.length;
    const candidates: Array<{ route: string; index: number }> = [];
    for (let offset = 0; offset < routes.length; offset++) {
      const index = (cursor + offset) % routes.length;
      const route = routes[index];
      const known = identities.get(route);
      if (known) { if (known.malId && wanted.has(known.malId)) matches[route] = known; }
      else candidates.push({ route, index });
    }
    if (!candidates.length) return { matches, incomplete: false };
    // Confere cada entrada da semana na própria fonte. O cache de perfis é compartilhado entre semanas e usuários;
    // títulos traduzidos ou temporadas ausentes de outro índice não podem impedir uma associação por ID.
    let incomplete = false;
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<void>(resolve => { timer = setTimeout(() => { expired = true; resolve(); }, 30_000); });
    try {
      for (let i = 0; i < candidates.length; i += 3) {
        const batch = candidates.slice(i, i + 3);
        // A próxima conferência começa depois do lote iniciado: perfis lentos no começo não bloqueiam o resto para sempre.
        matchCursors.set(cursorKey, (batch[batch.length - 1].index + 1) % routes.length);
        const pending = Promise.all(batch.map(async ({ route }) => {
          try { const ids = await identity(route); if (ids.malId && wanted.has(ids.malId)) matches[route] = ids; }
          catch { incomplete = true; }
        }));
        await Promise.race([pending, deadline]);
        if (expired) { incomplete = true; break; }
      }
      // No máximo o lote já iniciado continua preenchendo o cache, sem alterar a resposta devolvida.
      return { matches: { ...matches }, incomplete };
    } finally { clearTimeout(timer!); }
  }
  return { get, identity, match };
}
export const animeScheduleService = createAnimeScheduleService();
