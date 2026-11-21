import { describe, expect, it } from 'vitest';
import { createCalendarService } from '../calendar';

const date = Date.parse('2026-11-14T20:00:00Z');
const media = { id: 195516, idMal: 61987, title: { english: 'The Apothecary Diaries Season 3' }, airingSchedule: { nodes: [{ episode: 8, airingAt: 1795183200 }] } };
const manifest = { subbed: { schedule: 's1', episodes: 'e1' }, dubbed: { schedule: 'd1', episodes: 'de1' } };

describe('serviço AniSchedule', () => {
  it('compartilha pedidos simultâneos e não baixa os feeds de novo quando o manifesto não mudou', async () => {
    let now = date;
    const hits: string[] = [];
    const service = createCalendarService(async file => {
      hits.push(file);
      return file === 'last-updated.json' ? manifest : file.includes('schedule') ? [media] : [{ id: media.id, episode: { aired: 7, airedAt: '2026-11-13T14:00:00Z' } }];
    }, () => now);
    const [a, b] = await Promise.all([service.get(), service.get()]);
    expect(a).toBe(b);
    expect(hits).toHaveLength(5);
    expect(a.events).toHaveLength(4);
    now += 16 * 60_000;
    await service.get();
    expect(hits).toHaveLength(6);
  });

  it('preserva a última agenda válida numa falha parcial e sinaliza a fonte afetada', async () => {
    let now = date;
    let fail = false;
    const service = createCalendarService(async file => {
      if (fail && file === 'v2/dub-schedule.json') throw new Error('offline');
      if (file === 'last-updated.json') return fail ? { ...manifest, dubbed: { schedule: 'd2', episodes: 'de1' } } : manifest;
      return file.includes('schedule') ? [media] : [{ id: media.id, episode: { aired: 7, airedAt: '2026-11-13T14:00:00Z' } }];
    }, () => now);
    await service.get();
    now += 16 * 60_000;
    fail = true;
    const result = await service.get();
    expect(result.stale).toBe(true);
    expect(result.failedSources).toEqual(['v2/dub-schedule.json']);
    expect(result.events.some(event => event.kind === 'dub' && event.episode === 8)).toBe(true);
  });

  it('não transforma falha total em uma semana vazia nem mantém dados vencidos', async () => {
    let now = date;
    let fail = false;
    const service = createCalendarService(async file => {
      if (fail) throw new Error('offline');
      return file === 'last-updated.json' ? manifest : [media];
    }, () => now);
    await service.get();
    now += 25 * 60 * 60_000;
    fail = true;
    await expect(service.get()).rejects.toThrow('calendar_unavailable');
  });

  it('uma resposta com array malformado não substitui a última agenda válida', async () => {
    let now = date;
    let malformed = false;
    const service = createCalendarService(async file => {
      if (file === 'last-updated.json') return { subbed: { schedule: malformed ? 's2' : 's1', episodes: 'e1' }, dubbed: manifest.dubbed };
      if (malformed && file === 'sub-schedule.json') return [null, { changedSchema: true }];
      return file.includes('schedule') ? [media] : [{ id: media.id, episode: { aired: 7, airedAt: '2026-11-13T14:00:00Z' } }];
    }, () => now);
    await service.get();
    now += 16 * 60_000;
    malformed = true;
    const result = await service.get();
    expect(result.stale).toBe(true);
    expect(result.failedSources).toEqual(['sub-schedule.json']);
    expect(result.events.some(event => event.kind === 'sub' && event.episode === 8)).toBe(true);
  });
});
