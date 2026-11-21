import { t } from '../../lib/i18n';

export function calendarFormatLabel(format: string): string {
  const labels: Record<string, string> = { TV: 'TV', TV_SHORT: t('Curtas de TV'), ONA: 'ONA', OVA: 'OVA', SPECIAL: t('Especiais'), MOVIE: t('Filmes'), OTHER: t('Outros') };
  return labels[format] ?? format;
}
