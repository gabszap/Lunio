import { normalizeCalendar, type CalendarData, type CalendarSource } from '../lib/calendar';

const BASE = 'https://raw.githubusercontent.com/RockinChaos/AniSchedule/master/raw/';
const FILES = ['sub-schedule.json', 'v2/dub-schedule.json', 'sub-episode-feed.json', 'dub-episode-feed.json'] as const;
const RECHECK_MS = 15 * 60_000;
const MAX_STALE_MS = 24 * 60 * 60_000;
type ReadJson = (file: string) => Promise<unknown>;

async function readJson(file: string): Promise<unknown> {
  const response = await fetch(`${BASE}${file}`, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`AniSchedule ${response.status}`);
  // Leitura limitada: não confiar no Content-Length nem alocar uma resposta arbitrária inteira.
  if (!response.body) throw new Error('AniSchedule sem corpo');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 12 * 1024 * 1024) throw new Error('AniSchedule muito grande');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Protótipo: cache em memória, URLs fixas, uma atualização compartilhada por vez. */
export function createCalendarService(read: ReadJson = readJson, now = () => Date.now()) {
  const stored = new Map<string, { data: unknown[]; at: number; signature: string }>();
  let cached: CalendarData | null = null;
  let nextCheck = 0;
  let inflight: Promise<CalendarData> | null = null;
  async function update(): Promise<CalendarData> {
    const time = now();
    let manifest: any;
    try { manifest = await read('last-updated.json'); } catch { /* os arquivos ainda podem estar acessíveis */ }
    const failedSources: string[] = [];
    const signatures = [manifest?.subbed?.schedule, manifest?.dubbed?.schedule, manifest?.subbed?.episodes, manifest?.dubbed?.episodes];
    const results = await Promise.all(FILES.map(async (file, i) => {
      const old = stored.get(file);
      const signature = typeof signatures[i] === 'string' ? signatures[i] : '';
      if (old && signature && old.signature === signature && time - old.at < MAX_STALE_MS) return old.data;
      try {
        const data = await read(file);
        if (!Array.isArray(data) || data.length === 0) throw new Error('Agenda inválida');
        const candidate: CalendarSource = { kind: i % 2 === 0 ? 'sub' : 'dub', schedule: i < 2 ? data : [], feed: i >= 2 ? data : [] };
        if (normalizeCalendar([candidate]).length === 0) throw new Error('Agenda sem registros válidos');
        stored.set(file, { data, at: time, signature });
        return data;
      } catch {
        failedSources.push(file);
        return old && time - old.at < MAX_STALE_MS ? old.data : [];
      }
    }));
    if (results.every(data => data.length === 0)) throw new Error('calendar_unavailable');
    const sources: CalendarSource[] = [
      { kind: 'sub', schedule: results[0], feed: results[2] },
      { kind: 'dub', schedule: results[1], feed: results[3] },
    ];
    const rangeStart = new Date(time - 42 * 86400_000).toISOString();
    const rangeEnd = new Date(time + 120 * 86400_000).toISOString();
    const events = normalizeCalendar(sources).filter(e => !e.at || (e.at >= rangeStart && e.at <= rangeEnd));
    const timestamps = signatures.filter((s): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s)));
    cached = { events, checkedAt: new Date(time).toISOString(), updatedAt: timestamps.sort().at(-1) ?? new Date(time).toISOString(),
      stale: failedSources.length > 0, failedSources, rangeStart, rangeEnd };
    nextCheck = time + (failedSources.length ? 60_000 : RECHECK_MS);
    return cached;
  }
  return {
    get(): Promise<CalendarData> {
      if (cached && now() < nextCheck) return Promise.resolve(cached);
      if (!inflight) inflight = update().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
export const calendarService = createCalendarService();
