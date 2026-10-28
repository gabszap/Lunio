import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasPendingStart, readStartTime } from './startTime';
import { MAX_CONTINUE, loadContinue, nextEpisodeOf, removeContinue, reportProgress, resumePositionFor, startPlayback, type ContinueRef } from './continueWatching';

const series: ContinueRef = {
  type: 'series',
  id: 'tt1',
  name: 'Anime',
  poster: 'https://img.test/p.jpg',
  episode: { videoId: 'tt1:1:2', season: 1, episode: 2 },
  next: { videoId: 'tt1:1:3', season: 1, episode: 3 },
};
const movie: ContinueRef = { type: 'movie', id: 'tt2', name: 'Filme' };

describe('continueWatching', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('window', { location: { search: '' }, dispatchEvent: () => true });
    startPlayback(null);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('guarda título, episódio e posição, sem nenhum link; antes dos 20 s não vira "continuar"', () => {
    startPlayback(series);
    reportProgress(12, 1400, 1_000);
    expect(loadContinue()).toEqual([]);
    reportProgress(120.7, 1400, 2_000);
    expect(loadContinue()).toEqual([
      { type: 'series', id: 'tt1', name: 'Anime', poster: 'https://img.test/p.jpg', videoId: 'tt1:1:2', season: 1, episode: 2, position: 120, duration: 1400, updatedAt: 2_000 },
    ]);
    expect(store.get('lunio_continue')).not.toMatch(/token|key|http.*\.mkv/i);
  });

  it('o player avisa várias vezes por segundo: só regrava depois de alguns segundos de avanço', () => {
    startPlayback(series);
    reportProgress(100, 1400, 1_000);
    reportProgress(101, 1400, 1_100);
    expect(loadContinue()[0].updatedAt).toBe(1_000);
    reportProgress(105, 1400, 1_200);
    expect(loadContinue()[0]).toMatchObject({ position: 105, updatedAt: 1_200 });
  });

  it('um título por entrada, a mais recente primeiro, até o máximo', () => {
    for (let i = 0; i < MAX_CONTINUE + 5; i++) {
      startPlayback({ type: 'movie', id: `tt${i}`, name: `F${i}` });
      reportProgress(60, 6000, 1_000 + i);
    }
    const list = loadContinue();
    expect(list).toHaveLength(MAX_CONTINUE);
    expect(list[0].id).toBe(`tt${MAX_CONTINUE + 4}`);
    startPlayback({ type: 'movie', id: 'tt10', name: 'F10' });
    reportProgress(90, 6000, 99_999);
    expect(loadContinue()[0]).toMatchObject({ id: 'tt10', position: 90 });
    expect(loadContinue().filter((e) => e.id === 'tt10')).toHaveLength(1);
  });

  it('terminou um episódio (95%): a entrada passa a ser o próximo, por começar', () => {
    startPlayback(series);
    reportProgress(300, 1400, 1_000);
    reportProgress(1340, 1400, 2_000); // 95,7%
    expect(loadContinue()).toEqual([
      { type: 'series', id: 'tt1', name: 'Anime', poster: 'https://img.test/p.jpg', videoId: 'tt1:1:3', season: 1, episode: 3, position: 0, duration: 0, next: true, updatedAt: 2_000 },
    ]);
    // depois dos créditos nada volta a regravar
    reportProgress(1390, 1400, 3_000);
    expect(loadContinue()[0].next).toBe(true);
    // e o "próximo" não é uma posição para retomar
    expect(resumePositionFor({ type: 'series', id: 'tt1', episode: { videoId: 'tt1:1:3', season: 1, episode: 3 } })).toBeNull();
  });

  it('terminou o filme ou o último episódio: sai da lista', () => {
    startPlayback(movie);
    reportProgress(100, 6000, 1_000);
    expect(loadContinue()).toHaveLength(1);
    reportProgress(5800, 6000, 2_000);
    expect(loadContinue()).toEqual([]);

    startPlayback({ ...series, next: null });
    reportProgress(100, 1400, 3_000);
    reportProgress(1390, 1400, 4_000);
    expect(loadContinue()).toEqual([]);
  });

  it('sem nada do catálogo tocando, nada é guardado', () => {
    startPlayback(null);
    reportProgress(500, 1400);
    expect(loadContinue()).toEqual([]);
  });

  it('resumePositionFor: só o mesmo episódio, em andamento; começar o vídeo deixa-o abrir nessa posição (uma vez)', () => {
    startPlayback(series);
    reportProgress(500, 1400, 1_000);
    expect(resumePositionFor(series)).toBe(500);
    expect(resumePositionFor({ type: 'series', id: 'tt1', episode: { videoId: 'tt1:1:3', season: 1, episode: 3 } })).toBeNull(); // outro episódio
    expect(resumePositionFor({ type: 'series', id: 'outro' })).toBeNull();

    startPlayback(series);
    expect(hasPendingStart()).toBe(true);
    expect(readStartTime()).toBe(500);
    startPlayback(null);
    expect(hasPendingStart()).toBe(false);

    startPlayback(movie);
    reportProgress(200, 6000, 2_000);
    startPlayback(movie);
    expect(readStartTime()).toBe(200);
  });

  it('removeContinue tira o título; armazenamento quebrado ou com lixo vira lista vazia', () => {
    startPlayback(movie);
    reportProgress(100, 6000, 1_000);
    removeContinue(movie);
    expect(loadContinue()).toEqual([]);
    store.set('lunio_continue', '{nao é json');
    expect(loadContinue()).toEqual([]);
    store.set('lunio_continue', JSON.stringify([{ type: 'movie', id: 'x' }, null, 5, { type: 'movie', id: 'tt9', name: 'Ok', position: 30, duration: 100, updatedAt: 1, poster: 'javascript:alert(1)' }]));
    expect(loadContinue()).toEqual([{ type: 'movie', id: 'tt9', name: 'Ok', poster: undefined, videoId: undefined, season: undefined, episode: undefined, position: 30, duration: 100, next: undefined, updatedAt: 1 }]);
  });

  it('nextEpisodeOf: segue a ordem de exibição, passa de temporada e ignora os especiais', () => {
    const eps = [
      { id: 'sp', season: 0, episode: 1 },
      { id: 'b2', season: 1, episode: 2 },
      { id: 'b1', season: 1, episode: 1 },
      { id: 'c1', season: 2, episode: 1 },
    ];
    expect(nextEpisodeOf(eps, 'b1')).toEqual({ videoId: 'b2', season: 1, episode: 2 });
    expect(nextEpisodeOf(eps, 'b2')).toEqual({ videoId: 'c1', season: 2, episode: 1 });
    expect(nextEpisodeOf(eps, 'c1')).toBeNull();
    expect(nextEpisodeOf(eps, 'sp')).toBeNull();
    expect(nextEpisodeOf(eps, 'nao-existe')).toBeNull();
  });
});
