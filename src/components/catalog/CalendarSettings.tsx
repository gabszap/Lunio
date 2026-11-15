import React from 'react';
import { CALENDAR_FORMATS, DEFAULT_CALENDAR_FILTERS, type CalendarFilters } from '../../lib/calendar';
import { t } from '../../lib/i18n';
import { X } from 'lucide-react';
import { Chip, IconButton, TextButton } from '../ui';

const choiceClass = '!flex-none !basis-auto !h-9 !rounded-full !px-3.5';
function Choices<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return <fieldset className="m-0 p-0 border-0 min-w-0"><legend className="text-[13px] font-semibold mb-3">{label}</legend><div className="flex flex-wrap gap-2">{options.map(option => <Chip key={option.value} selected={value === option.value} className={choiceClass} onClick={() => onChange(option.value)}>{option.label}</Chip>)}</div></fieldset>;
}

export function CalendarSettings({ value, onChange, platforms, onClose }: { value: CalendarFilters; onChange: (value: CalendarFilters) => void; platforms: string[]; onClose: () => void }) {
  const labels: Record<string, string> = { TV: 'TV', TV_SHORT: t('Curtas de TV'), ONA: 'ONA', OVA: 'OVA', SPECIAL: t('Especiais'), MOVIE: t('Filmes'), OTHER: t('Outros') };
  return (
    <section aria-label={t('Filtros do calendário')} onKeyDown={event => { if (event.key === 'Escape') onClose(); }} className="relative rounded-[16px] border border-lu-border-strong bg-lu-surface p-5 sm:p-6 flex flex-col gap-6">
      <div className="absolute right-3 top-3"><IconButton label={t('Fechar filtros')} size={36} tone="muted" onClick={onClose}><X size={17} /></IconButton></div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-7 lg:gap-8">
        <div className="flex flex-col gap-6">
          <h2 className="m-0 text-[17px] font-semibold text-lu-accent">{t('Configurações')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-x-5 gap-y-6">
            <Choices<CalendarFilters['kind']> label={t('Tipo de lançamento')} value={value.kind} onChange={kind => onChange({ ...value, kind })} options={[{ value: 'all', label: t('Todos') }, { value: 'sub', label: 'Sub' }, { value: 'dub', label: 'Dub' }]} />
            <fieldset className="m-0 p-0 border-0 min-w-0">
              <legend className="text-[13px] font-semibold mb-3">{t('Ocultar Sub quando')}</legend>
              <Chip className={choiceClass} selected={value.prefer === 'dub'} disabled={value.kind !== 'all'} title={value.kind !== 'all' ? t('Selecione Todos para comparar Sub e Dub.') : undefined} onClick={() => onChange({ ...value, prefer: value.prefer === 'dub' ? 'all' : 'dub' })}>{t('Houver Dub')}</Chip>
            </fieldset>
            <fieldset className="m-0 p-0 border-0 min-w-0">
              <legend className="text-[13px] font-semibold mb-3">{t('Ocultar Dub quando')}</legend>
              <Chip className={choiceClass} selected={value.prefer === 'sub'} disabled={value.kind !== 'all'} title={value.kind !== 'all' ? t('Selecione Todos para comparar Sub e Dub.') : undefined} onClick={() => onChange({ ...value, prefer: value.prefer === 'sub' ? 'all' : 'sub' })}>{t('Houver Sub')}</Chip>
            </fieldset>
            <Choices label={t('Formato do horário')} value={value.hour12 ? '12' : '24'} onChange={choice => onChange({ ...value, hour12: choice === '12' })} options={[{ value: '24', label: '24h' }, { value: '12', label: '12h' }]} />
            <Choices label={t('Capas')} value={value.showImages ? 'show' : 'hide'} onChange={choice => onChange({ ...value, showImages: choice === 'show' })} options={[{ value: 'show', label: t('Mostrar') }, { value: 'hide', label: t('Ocultar') }]} />
            <Choices label="Donghua" value={value.showDonghua ? 'show' : 'hide'} onChange={choice => onChange({ ...value, showDonghua: choice === 'show' })} options={[{ value: 'show', label: t('Mostrar') }, { value: 'hide', label: t('Ocultar') }]} />
            <div className="sm:col-span-2 2xl:col-span-3"><Choices<CalendarFilters['sort']> label={t('Ordenar por')} value={value.sort} onChange={sort => onChange({ ...value, sort })} options={[{ value: 'popularity', label: t('Popularidade') }, { value: 'time', label: t('Horário') }, { value: 'name', label: t('Nome') }]} /></div>
          </div>
        </div>
        <div className="flex flex-col gap-6 lg:pl-8 lg:border-l border-lu-border-strong">
          <h2 className="m-0 text-[17px] font-semibold text-lu-accent">{t('Filtros')}</h2>
          <fieldset className="m-0 p-0 border-0 min-w-0">
            <legend className="text-[13px] font-semibold mb-3">{t('Formato')}</legend>
            <div className="flex flex-wrap gap-2">
              {CALENDAR_FORMATS.map(format => <Chip key={format} selected={value.formats.includes(format)} className="!flex-none !basis-auto !h-9 !rounded-full !px-3.5" onClick={() => onChange({ ...value, formats: value.formats.includes(format) ? value.formats.filter(f => f !== format) : [...value.formats, format] })}>{labels[format]}</Chip>)}
            </div>
          </fieldset>
          <fieldset className="m-0 p-0 border-0 min-w-0">
            <legend className="text-[13px] font-semibold mb-3">{t('Plataforma')}</legend>
            <div className="flex flex-wrap gap-2">
              <Chip selected={!value.platform} className="!flex-none !basis-auto !h-9 !rounded-full !px-3.5" onClick={() => onChange({ ...value, platform: '' })}>{t('Todas as plataformas')}</Chip>
              {[...new Set([...platforms, ...(value.platform ? [value.platform] : [])])].sort().map(platform => <Chip key={platform} selected={value.platform === platform} className="!flex-none !basis-auto !h-9 !rounded-full !px-3.5" onClick={() => onChange({ ...value, platform: value.platform === platform ? '' : platform })}>{platform}</Chip>)}
            </div>
          </fieldset>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pt-3 border-t border-lu-border-strong">
          <TextButton size="sm" onClick={() => onChange({ ...value, formats: [...CALENDAR_FORMATS], showDonghua: true, platform: '', kind: 'all', prefer: 'all' })}>{t('Limpar filtros')}</TextButton>
          <TextButton size="sm" onClick={() => onChange({ ...DEFAULT_CALENDAR_FILTERS })}>{t('Restaurar filtros')}</TextButton>
      </div>
    </section>
  );
}
