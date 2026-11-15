import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import { apiFetch } from '../../lib/access';
import { calendarWeek, localDayKey, matchCalendarItem, filterCalendarEvents, parseCalendarFilters, type CalendarData, type CalendarEvent, type CalendarMatches, type CalendarFilters } from '../../lib/calendar';
import { fetchMeta, type CatalogItem } from '../../lib/catalog';
import { t, useLang } from '../../lib/i18n';
import { GhostButton, IconButton, PillTabs, Spinner, TextButton, cx } from '../ui';
import { CalendarSettings } from './CalendarSettings';

interface Props { myList: CatalogItem[]; onOpen: (item: CatalogItem) => void; onBack: () => void }
const PREFS = 'lunio_calendar_filters';
function loadFilters(): CalendarFilters {
  try { return parseCalendarFilters(JSON.parse(localStorage.getItem(PREFS) || 'null')); } catch { return parseCalendarFilters(null); }
}
async function readJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await apiFetch(`/api/catalog/${path}`, { signal });
  if (!response.ok) throw new Error('calendar');
  return response.json();
}

/** Protótipo funcional AniSchedule: somente Sub e Dub; lista pessoal continua no navegador. */
export function Calendar({ myList, onOpen, onBack }: Props) {
  const lang = useLang();
  const locale = lang === 'pt' ? 'pt-BR' : 'en-US';
  const [anchor, setAnchor] = useState(() => new Date());
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [onlyMine, setOnlyMine] = useState(false);
  const [filters, setFilters] = useState<CalendarFilters>(loadFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [identities, setIdentities] = useState<Record<string, { malId?: string; anilistId?: number }>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [loadedWeek, setLoadedWeek] = useState('');
  const [resolved, setResolved] = useState<Record<string, string[]>>({});
  const [checking, setChecking] = useState(false);
  const [mappingFailures, setMappingFailures] = useState(0);
  const [mappingIncomplete, setMappingIncomplete] = useState(false);
  const [now, setNow] = useState(Date.now());
  const days = useMemo(() => calendarWeek(anchor), [anchor]);
  const weekStart = localDayKey(days[0]);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weekKey = `${weekStart}:${timezone}`;
  const activeData = loadedWeek === weekKey ? data : null;
  const params = useMemo(() => new URLSearchParams({ date: weekStart, tz: timezone }), [weekStart, timezone]);
  const weekLabel = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(days[0], days[6]);
  const today = localDayKey(new Date(now));

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    readJson<CalendarData>(`calendar?${params}`, controller.signal)
      .then(body => { if (active) { setData(body); setLoadedWeek(weekKey); } })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [attempt, params, weekKey]);

  useEffect(() => { try { localStorage.setItem(PREFS, JSON.stringify(filters)); } catch { /* armazenamento indisponível */ } }, [filters]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Só resolve os acompanhamentos quando o filtro é usado. Nunca associa uma temporada apenas pelo nome.
  useEffect(() => {
    if (!onlyMine) return;
    let active = true;
    setChecking(true);
    setMappingFailures(0);
    setMappingIncomplete(false);
    const list = myList.filter(item => item.type !== 'movie');
    void (async () => {
      const ids: Record<string, string[]> = {};
      let failures = 0;
      for (let i = 0; i < list.length && active; i += 3) {
        await Promise.all(list.slice(i, i + 3).map(async item => {
          try {
            const meta = await fetchMeta(item.type, item.id);
            ids[item.id] = [...new Set([meta.malId, ...(meta.seriesMalIds ?? []), ...Object.values(meta.seasonMalIds ?? {})].filter((id): id is string => !!id))];
          } catch { failures++; }
        }));
        if (active) { setResolved({ ...ids }); setMappingFailures(failures); }
      }
      if (active) {
        const malIds = [...new Set([...Object.values(ids).flat(), ...list.filter(item => item.id.startsWith('mal:')).map(item => item.id.slice(4))])].slice(0, 300);
        if (malIds.length) {
          try {
            const result = await readJson<CalendarMatches>(`calendar-match?${params}&ids=${malIds.join(',')}`);
            if (active) {
              setIdentities(current => ({ ...current, ...result.matches }));
              setMappingIncomplete(result.incomplete);
            }
          } catch { if (active) setMappingIncomplete(true); }
        }
        if (active) setChecking(false);
      }
    })();
    return () => { active = false; };
  }, [onlyMine, myList, params, attempt]);

  const enhancedEvents = useMemo(() => (activeData?.events ?? []).map(event => {
    const target = { ...event, ...(event.route ? identities[event.route] : {}) };
    const item = matchCalendarItem(target, myList, resolved);
    return { ...target, aliases: [...(event.aliases ?? []), ...(item ? [item.name] : [])] };
  }), [activeData, identities, myList, resolved]);
  const filtered = useMemo(() => filterCalendarEvents(enhancedEvents, filters, query).filter(event =>
    !onlyMine || matchCalendarItem(event, myList, resolved)
  ), [enhancedEvents, filters, query, onlyMine, myList, resolved]);
  const platforms = useMemo(() => [...new Set((activeData?.events ?? []).flatMap(event => event.platforms ?? []))], [activeData]);
  const buckets = days.map(day => {
    const key = localDayKey(day);
    return { day, key, events: filtered.filter(event => event.at && localDayKey(new Date(event.at)) === key) };
  });
  const count = buckets.reduce((sum, bucket) => sum + bucket.events.length, 0);
  const undated = filtered.filter(event => !event.at && event.delayed);
  const moveWeek = (step: number) => setAnchor(date => new Date(date.getFullYear(), date.getMonth(), date.getDate() + step * 7, 12));
  const titleFor = (event: CalendarEvent) => event.title;
  const open = async (event: CalendarEvent) => {
    setOpening(event.key);
    setOpenError(null);
    try {
      const ids = event.route ? await readJson<{ malId?: string; anilistId?: number }>(`calendar-identity?route=${encodeURIComponent(event.route)}`) : event;
      if (event.route) setIdentities(current => ({ ...current, [event.route!]: ids }));
      const target = { ...event, ...ids };
      const item = matchCalendarItem(target, myList, resolved);
      // O título abre pelo ID confirmado; a numeração do episódio continua sendo a do catálogo.
      if (item) onOpen(item);
      else if (target.malId) onOpen({ id: `mal:${target.malId}`, type: 'series', name: target.title, poster: target.poster });
      else throw new Error('Sem ID compatível');
    } catch { setOpenError(event.route ?? ''); }
    finally { setOpening(null); }
  };
  const renderEvent = (event: CalendarEvent) => (
    <button key={event.key} type="button" onClick={() => void open(event)} disabled={opening !== null}
      aria-label={t('Abrir {title}, episódio {episode}, {kind}', { title: titleFor(event), episode: event.episode, kind: event.kind === 'sub' ? 'Sub' : 'Dub' })}
      className="group block w-full text-left rounded-[10px] overflow-hidden bg-lu-surface border border-lu-border hover:border-lu-accent/60 transition-colors disabled:cursor-wait">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1 px-2 py-2 text-[12px] bg-lu-elevated">
        <span className="text-lu-muted tabular">{t('Ep. {episode}', { episode: event.episode })}</span>
        <span className="tabular text-lu-text font-semibold">
          {opening === event.key ? <Spinner size={14} /> : event.at ? new Date(event.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: filters.hour12 }) : t('Sem data')}
        </span>
        <span className={cx('inline-flex items-center justify-center justify-self-end w-fit text-[11px] leading-none font-semibold rounded px-1.5 py-0.5', event.kind === 'sub' ? 'bg-lu-blue/10 text-lu-blue' : 'bg-lu-tint text-lu-accent')}>
          {event.kind === 'sub' ? 'Sub' : 'Dub'}
        </span>
      </div>
      {filters.showImages ? <div className="relative aspect-[2/3] w-full bg-lu-elevated">
        <span className="absolute inset-0 flex items-center justify-center text-lu-disabled"><CalendarDays size={36} /></span>
        {event.poster && <img data-calendar-poster src={event.poster} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none'; }} className="absolute inset-0 w-full h-full object-cover" />}
        <div className="absolute inset-x-0 bottom-0 pt-16 px-2.5 pb-3 bg-linear-to-t from-black/95 via-black/65 to-transparent">
          <span className="block text-[12px] sm:text-[13px] leading-[1.35] font-semibold text-white line-clamp-4 text-center" title={titleFor(event)}>{titleFor(event)}</span>
        </div>
        {event.delayed && <span className="absolute inset-x-0 top-0 py-1 px-2 bg-lu-warning text-lu-bg text-center text-[11px] font-semibold">{t('Adiado')}</span>}
      </div> : <div className="p-3"><span className="block text-[13px] font-semibold leading-snug">{titleFor(event)}</span>{event.delayed && <span className="block mt-2 text-[11px] text-lu-warning">{t('Adiado')}</span>}</div>}
    </button>
  );

  return (
    <div className="flex flex-col gap-6">
      <div><TextButton onClick={onBack}><ChevronLeft size={18} />{t('Catálogo')}</TextButton></div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3"><CalendarDays size={24} className="text-lu-accent" /><h1 className="m-0 text-[28px] font-semibold tracking-[-0.03em]">{t('Calendário')}</h1>
            <span className="text-[11px] text-lu-muted border border-lu-border-strong rounded-md px-2 py-1">{t('Experimental')}</span></div>
          <p className="m-0 mt-2 text-[14px] text-lu-muted">{t('A semana dos seus animes, em Sub e Dub.')}</p>
        </div>
        <label className="inline-flex gap-3 items-center h-11 px-3 rounded-[10px] bg-lu-surface border border-lu-border text-[13px] font-medium">
          <input type="checkbox" role="switch" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} className="w-4 h-4 accent-lu-accent" />{t('Só minha lista')}
        </label>
      </header>
      <div className="flex flex-wrap gap-4 items-center justify-between">
        <div className="flex items-center gap-1">
          <IconButton label={t('Semana anterior')} size={36} onClick={() => moveWeek(-1)} disabled={!!data && days[0].getTime() - 7 * 86400_000 < Date.parse(data.rangeStart)}><ChevronLeft size={18} /></IconButton>
          <h2 className="m-0 px-1 text-[13px] sm:text-[15px] font-semibold tabular whitespace-nowrap">{weekLabel}</h2>
          <IconButton label={t('Próxima semana')} size={36} onClick={() => moveWeek(1)} disabled={!!data && days[6].getTime() + 7 * 86400_000 > Date.parse(data.rangeEnd)}><ChevronRight size={18} /></IconButton>
          <TextButton size="sm" onClick={() => setAnchor(new Date())}>{t('Hoje')}</TextButton>
        </div>
        <div className="flex items-center gap-2">
          <PillTabs label={t('Tipo de lançamento')} size="sm" value={filters.kind} onChange={kind => setFilters(current => ({ ...current, kind }))} options={[{ value: 'all' as const, label: t('Todos') }, { value: 'sub' as const, label: 'Sub' }, { value: 'dub' as const, label: 'Dub' }]} />
          <IconButton label={t('Atualizar calendário')} size={36} disabled={loading} onClick={() => setAttempt(n => n + 1)}><RefreshCw size={16} /></IconButton>
          <GhostButton onClick={() => setFiltersOpen(value => !value)} aria-expanded={filtersOpen}><SlidersHorizontal size={16} />{t('Filtros')}</GhostButton>
        </div>
      </div>
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <label className="flex items-center gap-2 h-11 px-3 rounded-[10px] bg-lu-surface border border-lu-border w-full sm:max-w-[400px] text-lu-muted"><Search size={17} /><input aria-label={t('Buscar no calendário')} type="search" placeholder={t('Buscar anime…')} value={query} onChange={e => setQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent outline-none text-lu-text text-[14px]" /></label>
      </div>
      {filtersOpen && <CalendarSettings value={filters} onChange={setFilters} platforms={platforms} onClose={() => setFiltersOpen(false)} />}
      {loading && !activeData && <div role="status" className="flex gap-2 items-center justify-center py-16 text-lu-muted"><Spinner size={18} />{t('Carregando lançamentos…')}</div>}
      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-lu-border p-5 bg-lu-surface"><span>{t('Não foi possível atualizar o calendário.')}</span><GhostButton onClick={() => setAttempt(n => n + 1)}>{t('Tentar de novo')}</GhostButton></div>}
      {openError !== null && <p role="alert" className="m-0 text-[13px] text-lu-warning">{t('Não foi possível ligar este anime ao catálogo.')} {openError && <a href={`https://animeschedule.net/anime/${openError}`} target="_blank" rel="noopener noreferrer" className="underline">{t('Ver na fonte')}</a>}</p>}
      {activeData && <>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-lu-muted">
          <span>{count === 1 ? t('1 lançamento na semana') : t('{count} lançamentos na semana', { count })}{onlyMine && checking && <span role="status"> · {t('Conferindo sua lista…')}</span>}</span>
          <span>{t('Horários no seu fuso')} · {timezone}</span>
        </div>
        {data.stale && <p role="status" className="m-0 text-[13px] text-lu-warning">{t('Parte da agenda não respondeu. Mostrando os dados disponíveis.')}</p>}
        {onlyMine && mappingFailures > 0 && <p role="status" className="m-0 text-[13px] text-lu-warning">{t('{count} títulos da lista não puderam ser conferidos.', { count: mappingFailures })}</p>}
        {onlyMine && mappingIncomplete && <p role="status" className="m-0 text-[13px] text-lu-warning">{t('Não foi possível conferir toda a agenda. Alguns animes da sua lista podem estar ausentes.')}</p>}
        {onlyMine && !checking && myList.filter(i => i.type !== 'movie').length === 0 && <p className="m-0 text-[14px] text-lu-muted">{t('Adicione animes à Minha lista para acompanhar os lançamentos aqui.')}</p>}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-7 gap-3 items-start">
          {buckets.map(({ day, key, events }) => <section key={key} aria-current={key === today ? 'date' : undefined} aria-label={day.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}
            className={cx('min-w-0 rounded-[16px] p-1.5', events.length === 0 && count > 0 && key !== today && 'hidden xl:block', key === today ? 'border-2 border-lu-accent/70 bg-lu-tint/40' : 'border border-lu-border-strong bg-lu-bg2/70')}>
            <header className={cx('xl:sticky xl:top-0 z-10 flex flex-col items-center gap-1 px-2 py-4 mb-2 rounded-[10px]', key === today ? 'bg-lu-accent text-lu-bg' : 'bg-lu-elevated text-lu-text')}>
              <span className={cx('text-[12px] capitalize', key === today ? 'text-lu-bg/80 font-medium' : 'text-lu-muted')}>{day.toLocaleDateString(locale, { day: 'numeric', month: 'short' })}{key === today && ` · ${t('Hoje')}`}</span>
              <span className="text-[18px] font-semibold capitalize">{day.toLocaleDateString(locale, { weekday: 'long' })}</span>
            </header>
            <div className="grid grid-cols-2 xl:grid-cols-1 gap-2">{events.length ? events.map(renderEvent) : <p className="col-span-full m-0 text-[12px] text-lu-muted text-center py-5">{t('Sem lançamentos informados')}</p>}</div>
          </section>)}
        </div>
        {undated.length > 0 && <section aria-label={t('Adiados sem data')}><h2 className="text-[15px] font-semibold">{t('Adiados sem data')}</h2><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3">{undated.map(renderEvent)}</div></section>}
        <footer className="flex flex-wrap gap-x-4 gap-y-2 text-[12px] text-lu-muted border-t border-lu-border pt-4">
          <a href="https://animeschedule.net/" target="_blank" rel="noopener noreferrer" className="text-lu-muted hover:text-lu-text">{t('Horários por AnimeSchedule.net')}</a>
          <span>{t('Consultado em {date}', { date: new Date(data.checkedAt).toLocaleString(locale) })}</span>
          <span>{t('A programação pode mudar.')}</span>
          {filtered.some(e => e.missingTitle && e.at && buckets.some(b => b.key === localDayKey(new Date(e.at!)) )) && <span>{t('Alguns títulos do histórico não têm metadados na agenda atual.')}</span>}
        </footer>
      </>}
    </div>
  );
}
