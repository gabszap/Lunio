import { describe, expect, it } from 'vitest';
import { normalizeCalendar, calendarWeek, localDayKey, matchCalendarItem } from './calendar';

describe('agenda AniSchedule', () => {
  const media = { id: 195516, idMal: 61987, title: { english: 'The Apothecary Diaries Season 3' }, airingSchedule: { nodes: [{ episode: 8, airingAt: 1795183200 }] } };

  it('mantém Sub e Dub como eventos separados e usa o histórico para os dias passados', () => {
    const events = normalizeCalendar([
      { kind: 'sub', schedule: [media], feed: [{ id: media.id, idMal: media.idMal, episode: { aired: 7, airedAt: '2026-11-13T14:00:00Z' } }] },
      { kind: 'dub', schedule: [{ ...media, airingSchedule: { nodes: [{ episode: 6, airingAt: 1795190400 }] } }], feed: [] },
    ]);
    expect(events.map(e => [e.kind, e.episode])).toEqual([['sub', 7], ['sub', 8], ['dub', 6]]);
  });

  it('descarta datas inválidas e repetições; mantém adiamentos sem inventar uma data', () => {
    const events = normalizeCalendar([{ kind: 'dub', schedule: [
      { ...media, airingSchedule: { nodes: [{ episode: 6, delayedIndefinitely: true }, { episode: 7, airingAt: 'ruim' }, { episode: 8, airingAt: 1795183200 }, { episode: 8, airingAt: 1795183200 }] } },
    ], feed: [] }]);
    expect(events).toHaveLength(2);
    expect(events.find(e => e.episode === 6)).toMatchObject({ at: null, delayed: true });
  });

  it('não associa por nome e respeita o MAL específico da temporada', () => {
    const event = normalizeCalendar([{ kind: 'sub', schedule: [media], feed: [] }])[0];
    const item = { id: 'tt123', type: 'series', name: 'Outro nome' };
    expect(matchCalendarItem(event, [item], { tt123: ['61987'] })).toEqual(item);
    expect(matchCalendarItem(event, [{ ...item, name: event.title }], {})).toBeUndefined();
    expect(matchCalendarItem(event, [{ id: 'mal:61987', type: 'series', name: 'Anime' }], {})).toBeDefined();
  });

  it('a semana começa na segunda e mantém sete dias locais mesmo na troca de horário de verão', () => {
    const week = calendarWeek(new Date(2026, 10, 1, 12));
    expect(week).toHaveLength(7);
    expect(week[0].getDay()).toBe(1);
    expect(week[6].getDay()).toBe(0);
    expect(localDayKey(week[0])).toBe('2026-10-26');
    expect(localDayKey(week[6])).toBe('2026-11-01');
  });
});
