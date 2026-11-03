import { beforeAll, describe, expect, it, vi } from 'vitest';
import { extractCleanTitleFromUrl, formatRecentTitle } from './recent';

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

describe('extractCleanTitleFromUrl', () => {
  beforeAll(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } }); // a função roda no navegador
  });

  it('arquivo no caminho (Torrentio) continua valendo', () => {
    expect(extractCleanTitleFromUrl('https://torrentio.strem.fun/resolve/torbox/x/ih/OSHI.NO.KO.S01E02.1080p.mkv/1/OSHI.NO.KO.S01E02.1080p.mkv')).toBe('OSHI.NO.KO.S01E02.1080p');
  });

  it('link de playback sem arquivo no caminho usa o torrent_name da query (antes dava "1")', () => {
    const url = 'https://comet.exemplo.test/CONFIG/playback/abc123/0/0/2/1?torrent_name=Shiguang.Dailiren.S02E01.1080p.AMZN.WEB-DL.JPN-VARYG.mkv&name=Link%20Click&media_id=tt1&media_type=series';
    expect(extractCleanTitleFromUrl(url)).toBe('Shiguang.Dailiren.S02E01.1080p.AMZN.WEB-DL.JPN-VARYG');
  });

  it('sem torrent_name, usa filename e depois name', () => {
    expect(extractCleanTitleFromUrl('https://x.test/play/9?filename=Meu.Filme.2020.mp4')).toBe('Meu.Filme.2020');
    expect(extractCleanTitleFromUrl('https://x.test/play/9?name=Link%20Click')).toBe('Link Click');
  });

  it('release sem extensão na query não perde o final do nome', () => {
    expect(extractCleanTitleFromUrl('https://x.test/play/9?torrent_name=Foo.S01E02.1080p')).toBe('Foo.S01E02.1080p');
  });

  it('caminho que termina em número não vira título', () => {
    expect(extractCleanTitleFromUrl('https://x.test/a/b/2/1')).toBe('');
    expect(extractCleanTitleFromUrl('https://x.test/play/meu-video')).toBe('meu-video');
  });
});

describe('chave dos streams recentes', () => {
  const store = new Map<string, string>();
  beforeAll(() => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it('lê a chave antiga uma vez e troca pela nova na primeira gravação', async () => {
    const { loadRecentStreams, saveRecentStreams } = await import('./recent');
    store.set('streamplayer_recent_streams', JSON.stringify([{ url: 'https://x.test/a.mkv', title: 'A', date: '01/01/2026' }]));
    expect(loadRecentStreams()).toHaveLength(1);
    saveRecentStreams(loadRecentStreams());
    expect(store.has('streamplayer_recent_streams')).toBe(false);
    expect(JSON.parse(store.get('lunio_recent_streams')!)).toHaveLength(1);
    saveRecentStreams([]);
    expect(store.has('lunio_recent_streams')).toBe(false);
  });
});
