import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, RefreshCw } from 'lucide-react';
import { apiFetch } from '../../lib/access';
import { calendarWeek, localDayKey, matchCalendarItem, type CalendarData, type CalendarEvent, type CalendarKind } from '../../lib/calendar';
import { fetchMeta, type CatalogItem } from '../../lib/catalog';
import { t, useLang } from '../../lib/i18n';
import { GhostButton, IconButton, PillTabs, Spinner, TextButton, cx } from '../ui';

interface Props { myList: CatalogItem[]; onOpen: (item: CatalogItem) => void; onBack: () => void }

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
  const [kind, setKind] = useState<'all' | CalendarKind>('all');
  const [resolved, setResolved] = useState<Record<string, string[]>>({});
  const [checking, setChecking] = useState(false);
  const [mappingFailures, setMappingFailures] = useState(0);
  const [now, setNow] = useState(Date.now());
  const days = useMemo(() => calendarWeek(anchor), [anchor]);
  const weekLabel = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(days[0], days[6]);
  const today = localDayKey(new Date(now));

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    apiFetch('/api/catalog/calendar', { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('calendar'); return response.json() as Promise<CalendarData>; })
      .then(body => { if (active) setData(body); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [attempt]);

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
    const list = myList.filter(item => item.type !== 'movie');
    void (async () => {
      const ids: Record<string, string[]> = {};
      let failures = 0;
      for (let i = 0; i < list.length && active; i += 3) {
        await Promise.all(list.slice(i, i + 3).map(async item => {
          try {
            const meta = await fetchMeta(item.type, item.id);
            ids[item.id] = [...new Set([meta.malId, ...Object.values(meta.seasonMalIds ?? {})].filter((id): id is string => !!id))];
          } catch { failures++; }
        }));
        if (active) { setResolved({ ...ids }); setMappingFailures(failures); }
      }
      if (active) setChecking(false);
    })();
    return () => { active = false; };
  }, [onlyMine, myList]);

  const filtered = useMemo(() => (data?.events ?? []).filter(event =>
    (kind === 'all' || kind === event.kind) && (!onlyMine || matchCalendarItem(event, myList, resolved))
  ), [data, kind, onlyMine, myList, resolved]);
  const buckets = days.map(day => {
    const key = localDayKey(day);
    return { day, key, events: filtered.filter(event => event.at && localDayKey(new Date(event.at)) === key) };
  });
  const count = buckets.reduce((sum, bucket) => sum + bucket.events.length, 0);
  const undated = filtered.filter(event => !event.at && event.delayed);
  const moveWeek = (step: number) => setAnchor(date => new Date(date.getFullYear(), date.getMonth(), date.getDate() + step * 7, 12));
  const titleFor = (event: CalendarEvent) => matchCalendarItem(event, myList, resolved)?.name ?? event.title;
  const open = (event: CalendarEvent) => {
    const item = matchCalendarItem(event, myList, resolved);
    // Sem correspondência de episódio comprovada, abre o título: o addon recebe o ID original na escolha do episódio.
    if (item) onOpen(item);
    else if (event.malId) onOpen({ id: `mal:${event.malId}`, type: 'series', name: event.title, poster: event.poster });
    else window.open(`https://anilist.co/anime/${event.anilistId}`, '_blank', 'noopener,noreferrer');
  };
  const renderEvent = (event: CalendarEvent) => (
    <button key={event.key} type="button" onClick={() => open(event)}
      aria-label={t('Abrir {title}, episódio {episode}, {kind}', { title: titleFor(event), episode: event.episode, kind: event.kind === 'sub' ? 'Sub' : 'Dub' })}
      className="group w-full text-left rounded-[10px] bg-lu-surface border border-lu-border hover:border-lu-border-strong hover:bg-lu-elevated transition-colors p-3 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 text-[12px]">
        <span className={cx('font-semibold rounded-md px-2 py-0.5', event.kind === 'sub' ? 'bg-lu-blue/10 text-lu-blue' : 'bg-lu-tint text-lu-accent')}>
          {event.kind === 'sub' ? 'Sub' : 'Dub'}
        </span>
        <span className="tabular text-lu-muted inline-flex items-center gap-1">
          {event.at ? <><Clock3 size={12} />{new Date(event.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })}</> : t('Sem data')}
        </span>
      </div>
      <div className="flex gap-2.5 min-w-0">
        {event.poster ? <img src={event.poster} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none'; }} className="w-10 h-[58px] rounded-md object-cover flex-none bg-lu-elevated" />
          : <span className="w-10 h-[58px] rounded-md flex-none flex items-center justify-center bg-lu-elevated text-lu-muted"><CalendarDays size={18} /></span>}
        <div className="min-w-0">
          <span className="block text-[12px] leading-[1.45] font-medium text-lu-text line-clamp-3" title={titleFor(event)}>{titleFor(event)}</span>
          <span className="block mt-1 text-[12px] text-lu-muted">{t('Episódio {episode}', { episode: event.episode })}</span>
        </div>
      </div>
      {event.delayed ? <span className="text-[11px] text-lu-warning">{t('Adiado')}</span>
        : event.at && Date.parse(event.at) <= now && <span className="text-[11px] text-lu-muted">{t('Já lançado')}</span>}
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
          <PillTabs label={t('Tipo de lançamento')} size="sm" value={kind} onChange={setKind} options={[{ value: 'all' as const, label: t('Todos') }, { value: 'sub' as const, label: 'Sub' }, { value: 'dub' as const, label: 'Dub' }]} />
          <IconButton label={t('Atualizar calendário')} size={36} disabled={loading} onClick={() => setAttempt(n => n + 1)}><RefreshCw size={16} /></IconButton>
        </div>
      </div>
      {loading && !data && <div role="status" className="flex gap-2 items-center justify-center py-16 text-lu-muted"><Spinner size={18} />{t('Carregando lançamentos…')}</div>}
      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-lu-border p-5 bg-lu-surface"><span>{t('Não foi possível atualizar o calendário.')}</span><GhostButton onClick={() => setAttempt(n => n + 1)}>{t('Tentar de novo')}</GhostButton></div>}
      {data && <>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-lu-muted">
          <span>{count === 1 ? t('1 lançamento na semana') : t('{count} lançamentos na semana', { count })}{onlyMine && checking && <span role="status"> · {t('Conferindo sua lista…')}</span>}</span>
          <span>{t('Horários no seu fuso')} · {Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
        </div>
        {data.stale && <p role="status" className="m-0 text-[13px] text-lu-warning">{t('Parte da agenda não respondeu. Mostrando os dados disponíveis.')}</p>}
        {onlyMine && mappingFailures > 0 && <p role="status" className="m-0 text-[13px] text-lu-warning">{t('{count} títulos da lista não puderam ser conferidos.', { count: mappingFailures })}</p>}
        {onlyMine && !checking && myList.filter(i => i.type !== 'movie').length === 0 && <p className="m-0 text-[14px] text-lu-muted">{t('Adicione animes à Minha lista para acompanhar os lançamentos aqui.')}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3 items-start">
          {buckets.map(({ day, key, events }) => <section key={key} aria-label={day.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}
            className={cx('min-w-0 rounded-[14px] p-2 border', events.length === 0 && count > 0 && 'hidden sm:block', key === today ? 'border-lu-accent/30 bg-lu-tint/25' : 'border-lu-border bg-lu-bg2/50')}>
            <header className={cx('flex items-center justify-between gap-2 px-1 py-2', events.length > 0 && 'mb-2')}>
              <span className={cx('text-[12px] font-semibold capitalize', key === today ? 'text-lu-accent' : 'text-lu-muted')}>{day.toLocaleDateString(locale, { weekday: 'short' })}</span>
              {events.length === 0 && <span className="sm:hidden text-[11px] text-lu-muted">{t('Sem lançamentos informados')}</span>}
              <span className={cx('text-[18px] font-semibold tabular', key === today ? 'text-lu-accent' : 'text-lu-text')}>{day.getDate()}</span>
            </header>
            <div className="flex flex-col gap-2">{events.length ? events.map(renderEvent) : <p className="hidden sm:block m-0 text-[12px] text-lu-muted text-center py-5">{t('Sem lançamentos informados')}</p>}</div>
          </section>)}
        </div>
        {undated.length > 0 && <section aria-label={t('Adiados sem data')}><h2 className="text-[15px] font-semibold">{t('Adiados sem data')}</h2><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3">{undated.map(renderEvent)}</div></section>}
        <footer className="flex flex-wrap gap-x-4 gap-y-2 text-[12px] text-lu-muted border-t border-lu-border pt-4">
          <a href="https://github.com/RockinChaos/AniSchedule" target="_blank" rel="noopener noreferrer" className="text-lu-muted hover:text-lu-text">{t('Agenda por AniSchedule')}</a>
          <span>{t('Consultado em {date}', { date: new Date(data.checkedAt).toLocaleString(locale) })}</span>
          <span>{t('A programação pode mudar.')}</span>
          {filtered.some(e => e.missingTitle && e.at && buckets.some(b => b.key === localDayKey(new Date(e.at!)) )) && <span>{t('Alguns títulos do histórico não têm metadados na agenda atual.')}</span>}
        </footer>
      </>}
    </div>
  );
}
