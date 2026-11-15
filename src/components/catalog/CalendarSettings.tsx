import React from 'react';
import { CALENDAR_FORMATS, DEFAULT_CALENDAR_FILTERS, type CalendarFilters } from '../../lib/calendar';
import { t } from '../../lib/i18n';
import { Chip, TextButton } from '../ui';

export function CalendarSettings({ value, onChange, platforms }: { value: CalendarFilters; onChange: (value: CalendarFilters) => void; platforms: string[] }) {
  const labels: Record<string, string> = { TV: 'TV', TV_SHORT: t('Curtas de TV'), ONA: 'ONA', OVA: 'OVA', SPECIAL: t('Especiais'), MOVIE: t('Filmes'), OTHER: t('Outros') };
  return (
    <section aria-label={t('Filtros do calendário')} className="rounded-[14px] border border-lu-border bg-lu-surface p-5 flex flex-col gap-5">
      <div className="flex flex-wrap gap-5 items-start justify-between">
        <fieldset className="m-0 p-0 border-0 min-w-0">
          <legend className="text-[13px] font-semibold mb-3">{t('Formato')}</legend>
          <div className="flex flex-wrap gap-2">
            {CALENDAR_FORMATS.map(format => <Chip key={format} selected={value.formats.includes(format)} className="!flex-none !basis-auto !px-3" onClick={() => onChange({ ...value, formats: value.formats.includes(format) ? value.formats.filter(f => f !== format) : [...value.formats, format] })}>{labels[format]}</Chip>)}
          </div>
        </fieldset>
        <label className="flex gap-2 items-center h-11 text-[13px]">
          <input type="checkbox" checked={value.showDonghua} onChange={e => onChange({ ...value, showDonghua: e.target.checked })} className="accent-lu-accent w-4 h-4" />{t('Mostrar Donghua')}
        </label>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <label className="flex flex-col gap-2 text-[13px] font-medium min-w-[200px]">
          {t('Plataforma')}
          <select value={value.platform} onChange={e => onChange({ ...value, platform: e.target.value })} className="h-10 px-3 rounded-[10px] bg-lu-bg2 border border-lu-border-strong text-lu-text">
            <option value="">{t('Todas as plataformas')}</option>
            {[...new Set([...platforms, ...(value.platform ? [value.platform] : [])])].sort().map(platform => <option key={platform} value={platform}>{platform}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <TextButton size="sm" onClick={() => onChange({ ...value, formats: [...CALENDAR_FORMATS], showDonghua: true, platform: '' })}>{t('Mostrar todos os formatos')}</TextButton>
          <TextButton size="sm" onClick={() => onChange({ ...DEFAULT_CALENDAR_FILTERS })}>{t('Restaurar filtros')}</TextButton>
        </div>
      </div>
    </section>
  );
}
