import React from 'react';
import { Filter } from 'lucide-react';
import { CALENDAR_FORMATS, type CalendarFilters } from '../../lib/calendar';
import { t } from '../../lib/i18n';
import { calendarFormatLabel } from './calendarLabels';
import { StreamingIcon } from './StreamingIcon';

export function CalendarFilterSummary({ filters, onlyMine }: { filters: CalendarFilters; onlyMine: boolean }) {
  const chips: Array<{ key: string; label: string; platform?: string }> = [];
  if (onlyMine) chips.push({ key: 'list', label: t('Biblioteca') });
  if (filters.kind !== 'all') chips.push({ key: 'kind', label: filters.kind === 'sub' ? 'Sub' : 'Dub' });
  if (!filters.showDonghua) chips.push({ key: 'donghua', label: t('Sem Donghua') });
  if (filters.formats.length < CALENDAR_FORMATS.length) {
    for (const format of filters.formats) chips.push({ key: format, label: calendarFormatLabel(format) });
    if (!filters.formats.length) chips.push({ key: 'empty', label: t('Nenhum formato selecionado') });
  }
  if (filters.platform) chips.push({ key: 'platform', label: filters.platform, platform: filters.platform });
  if (filters.kind === 'all' && filters.prefer !== 'all') chips.push({ key: 'prefer', label: filters.prefer === 'sub' ? t('Ocultar Dub com Sub') : t('Ocultar Sub com Dub') });
  return <section aria-label={t('Filtros ativos')} className="w-full sm:w-auto flex flex-wrap items-center gap-2">
    <span className="inline-flex items-center gap-1.5 text-[12px] text-lu-muted mr-1"><Filter size={16} />{t('Filtros ativos')}</span>
    {chips.length ? chips.map(chip => <span key={chip.key} className="inline-flex items-center gap-1.5 rounded-md bg-lu-tint border border-lu-accent/30 px-2 py-1 text-[12px] font-semibold text-lu-accent">{chip.platform && <StreamingIcon platform={chip.platform} />}{chip.label}</span>) : <span className="text-[12px] text-lu-muted">{t('Nenhum filtro ativo')}</span>}
  </section>;
}
