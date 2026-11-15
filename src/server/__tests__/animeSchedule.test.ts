import { describe, expect, it, vi } from 'vitest';
import { parseTimetable, parseScheduleIdentity, isoWeek, createAnimeScheduleService } from '../animeSchedule';

function tile(kind: string, time: string) {
  return `<div data-route="nia-liston" data-aired-episode="6" data-episodes="25" data-popularity="992.41" data-media-types="tv" class="timetable-column-show">
    <a class="show-link"><img class="show-poster" src="https://img.animeschedule.net/nia.jpg"><h2 class="show-title-bar">Nia &amp; Liston</h2></a>
    <h3 class="time-bar"><time class="show-air-time" datetime="${time}">08:55</time><span class="air-type-text" data-air-type="${kind}">SUB</span></h3>
    <div class="show-streams"><a class="stream-link" title="HiDive"></a></div></div>`;
}
const html = `<div id="timetable">${tile('raw', '2026-11-10T08:25-04:00')}${tile('sub', '2026-11-10T08:55-04:00')}${tile('dub', '2026-11-10T10:00-04:00')}</div>`;

describe('AnimeSchedule: horários reais de distribuição', () => {
  it('Nia Liston usa 08:55 Sub, descarta Raw e converte o offset uma única vez', () => {
    const events = parseTimetable(html);
    expect(events).toHaveLength(2);
    expect(events.find(e => e.kind === 'sub')).toMatchObject({ at: '2026-11-10T12:55:00.000Z', title: 'Nia & Liston', format: 'TV', platforms: ['HiDive'], totalEpisodes: 25 });
    expect(events.some(e => e.at === '2026-11-10T12:25:00.000Z')).toBe(false);
  });

  it('ignora marcação fora da grade, horários sem offset e payload que perdeu a grade', () => {
    expect(parseTimetable(`<div id="timetable">${tile('sub', 'inválido')}</div>`)).toEqual([]);
    expect(parseTimetable(`<div id="timetable">${tile('sub', '2026-11-10T08:55')}</div>`)).toEqual([]);
    expect(() => parseTimetable('<html>Erro</html>')).toThrow();
    expect(parseTimetable(`${tile('sub', '2026-11-10T12:55Z')}<div id="timetable"></div>`)).toEqual([]);
  });

  it('recupera a capa real quando a fonte usa noscript e um pixel transparente no img principal', () => {
    const lazy = tile('sub', '2026-11-10T08:55-04:00').replace('<img class="show-poster" src="https://img.animeschedule.net/nia.jpg">', '<noscript><img class="show-poster" src="https://img.animeschedule.net/nia.jpg"></noscript><img class="show-poster" src="data:image/gif;base64,R0lGODlh">');
    expect(parseTimetable(`<div id="timetable">${lazy}</div>`)[0].poster).toBe('https://img.animeschedule.net/nia.jpg');
  });

  it('extrai IDs apenas dos links das fontes, sem deduzir pelo título', () => {
    expect(parseScheduleIdentity('<a class="anime-link myanimelist-link" href="//myanimelist.net/anime/63382/Nia">MAL</a><a class="anime-link anilist-link" href="https://anilist.co/anime/206949/">AL</a><section class="comments"><a href="https://myanimelist.net/anime/42">Outro anime</a></section>')).toEqual({ malId: '63382', anilistId: 206949 });
    expect(parseScheduleIdentity('<a href="https://evil.test/?next=//myanimelist.net/anime/42">x</a>')).toEqual({});
  });

  it('usa a semana ISO correta na virada do ano', () => {
    expect(isoWeek('2027-01-01')).toEqual({ year: 2026, week: 53 });
    expect(isoWeek('2026-11-09')).toEqual({ year: 2026, week: 46 });
    expect(isoWeek('2027-01-04')).toEqual({ year: 2027, week: 1 });
    expect(isoWeek('2026-12-28')).toEqual({ year: 2026, week: 53 });
  });

  it('envia o fuso com barra literal no cookie, conforme o formato aceito pela fonte', async () => {
    const fetcher = vi.fn(async () => new Response(html));
    vi.stubGlobal('fetch', fetcher);
    try {
      await createAnimeScheduleService().get('2026-11-09', 'Asia/Tokyo');
      expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Cookie: 'as_timezone=Asia/Tokyo' });
    } finally { vi.unstubAllGlobals(); }
  });

  it('preserva a grade válida numa falha ou mudança de HTML e sinaliza o cache antigo', async () => {
    let now = Date.parse('2026-11-14T20:00Z');
    let fail = false;
    let calls = 0;
    const service = createAnimeScheduleService(async () => { calls++; return fail ? '<html>Erro</html>' : html; }, () => now);
    const [a, b] = await Promise.all([service.get('2026-11-09', 'America/Halifax'), service.get('2026-11-09', 'America/Halifax')]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    now += 16 * 60_000;
    fail = true;
    const stale = await service.get('2026-11-09', 'America/Halifax');
    expect(stale.stale).toBe(true);
    expect(stale.events).toEqual(a.events);
    now += 25 * 60 * 60_000;
    await expect(service.get('2026-11-09', 'America/Halifax')).rejects.toThrow();
  });

  it('liga a lista pelo ID da própria fonte sem depender de nomes de um índice auxiliar', async () => {
    const profile = vi.fn(async (path: string) => path.startsWith('/anime/') ? '<a class="anime-link myanimelist-link" href="//myanimelist.net/anime/63382">MAL</a>' : html);
    const service = createAnimeScheduleService(profile);
    expect(await service.match('2026-11-09', 'UTC', ['63382'])).toEqual({ matches: { 'nia-liston': { malId: '63382' } }, incomplete: false });
    expect(await service.match('2026-11-09', 'UTC', ['777'])).toEqual({ matches: {}, incomplete: false });
    expect(profile.mock.calls.filter(([path]) => path.startsWith('/anime/'))).toHaveLength(1);
  });

  it('retorna associações confirmadas e avisa quando parte dos perfis falha', async () => {
    const service = createAnimeScheduleService(async path => {
      if (path === '/anime/falhou') throw new Error('offline');
      return path.startsWith('/anime/') ? '<a class="myanimelist-link" href="//myanimelist.net/anime/63382">MAL</a>' : html.replace('id="timetable">', `id="timetable">${tile('sub', '2026-11-10T08:55-04:00').replace('nia-liston', 'falhou')}`);
    });
    expect(await service.match('2026-11-09', 'UTC', ['63382', '777'])).toEqual({ matches: { 'nia-liston': { malId: '63382' } }, incomplete: true });
    expect(await service.match('2026-11-09', 'UTC', [])).toEqual({ matches: {}, incomplete: false });
  });

  it('limita a espera de perfis travados e retoma por outras rotas na próxima atualização', async () => {
    vi.useFakeTimers();
    try {
      const timetable = `<div id="timetable">${['a-travou', 'b-travou', 'c-travou', 'nia-liston'].map(route => tile('sub', '2026-11-10T08:55-04:00').replace('nia-liston', route)).join('')}</div>`;
      const read = vi.fn(async (path: string) => {
        if (!path.startsWith('/anime/')) return timetable;
        if (path.includes('travou')) return new Promise<string>(() => {});
        return '<a class="myanimelist-link" href="//myanimelist.net/anime/63382">MAL</a>';
      });
      const service = createAnimeScheduleService(read);
      let settled = false;
      const first = service.match('2026-11-09', 'UTC', ['63382']).then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(true);
      expect(await first).toEqual({ matches: {}, incomplete: true });
      const next = service.match('2026-11-09', 'UTC', ['63382']);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await next).toEqual({ matches: { 'nia-liston': { malId: '63382' } }, incomplete: true });
      expect(read.mock.calls.filter(([path]) => path === '/anime/nia-liston')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});
