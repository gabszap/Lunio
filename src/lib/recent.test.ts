import { describe, expect, it } from 'vitest';
import { formatRecentTitle } from './recent';

describe('formatRecentTitle', () => {
  it('reconhece S01E02 como antes', () => {
    expect(formatRecentTitle('OSHI.NO.KO.S01E02.Third.Option.1080p.CR.WEB-DL')).toMatchObject({ epTag: 'S01E02' });
  });

  it('anime de fansub "Título - 04" vira E04 e o número sai do nome', () => {
    const r = formatRecentTitle('[Erai-raws] JoJo no Kimyou na Bouken - Steel Ball Run - 04 [1080p NF WEB-DL AVC AAC][MultiSub][CE60799F]');
    expect(r.epTag).toBe('E04');
    expect(r.cleanName).toBe('JoJo no Kimyou na Bouken Steel Ball Run');
  });

  it('episódio de 3 dígitos com versão (v2)', () => {
    expect(formatRecentTitle('[Group] One Piece - 107v2 [720p]').epTag).toBe('E107');
  });

  it('ano depois do hífen continua sendo filme', () => {
    expect(formatRecentTitle('Blade Runner - 2049 1080p BluRay').epTag).toBe('FILME');
    expect(formatRecentTitle('Sintel.2010.1080p').epTag).toBe('FILME');
  });
});
