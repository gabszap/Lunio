import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendApiError, sendJson } from '../http';
import { animeScheduleService, validCalendarQuery } from '../animeSchedule';
import {
  CATALOG_ID_RE,
  CATALOG_TYPE_RE,
  CatalogUnavailableError,
  getManifest,
  fetchMalScore,
  getMeta,
  getRow,
  search,
} from '../catalog';

/**
 * /api/catalog/* — o catálogo (fileiras, busca e detalhes) vindo da fonte configurada em `CATALOG_URL` (padrão: Cinemeta).
 *   GET manifest                              → fileiras da Home e catálogos de busca
 *   GET row?type=&id=[&genre=][&skip=]        → itens de uma fileira
 *   GET search?q=                             → busca em cada catálogo de busca da fonte, em grupos (como o Stremio)
 *   GET meta?type=&id=                        → detalhes (com episódios, inclusive a temporada 0)
 *   GET malscore?id=<id do MyAnimeList>       → nota do anime no MAL (pedida à parte, com tentativas)
 *   GET calendar?date=YYYY-MM-DD&tz=         → semana Sub/Dub da tabela pública do AnimeSchedule
 *   GET calendar-match?date=&tz=&ids=        → liga IDs do MAL às entradas da semana, conferindo a fonte
 *   GET calendar-identity?route=              → IDs publicados na página do anime no AnimeSchedule
 * Respostas servidas do cache antigo (fonte fora do ar) trazem `stale: true`. Nada aqui aceita uma URL do navegador.
 */
export async function handleCatalog(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '', 'http://localhost');
  const action = url.pathname.replace(/^\/+/, '').split('/')[0];
  const param = (name: string) => url.searchParams.get(name) ?? '';
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method !== 'GET') return void sendApiError(res, 405, 'method_not_allowed');

    if (action === 'calendar' || action === 'calendar-match') {
      const day = param('date') || new Date().toISOString().slice(0, 10);
      const timezone = param('tz') || 'UTC';
      if (!validCalendarQuery(day, timezone)) return void sendApiError(res, 400, 'bad_request');
      const ids = param('ids').split(',').filter(Boolean);
      if (action === 'calendar-match' && (ids.length > 300 || ids.some(id => !/^\d{1,10}$/.test(id)))) return void sendApiError(res, 400, 'bad_request');
      try { return void sendJson(res, 200, action === 'calendar' ? await animeScheduleService.get(day, timezone) : await animeScheduleService.match(day, timezone, ids)); }
      catch { return void sendApiError(res, 502, 'catalog_unavailable'); }
    }

    if (action === 'calendar-identity') {
      const route = param('route');
      if (route.length > 240 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route)) return void sendApiError(res, 400, 'bad_request');
      try { return void sendJson(res, 200, await animeScheduleService.identity(route)); }
      catch { return void sendApiError(res, 502, 'catalog_unavailable'); }
    }

    if (action === 'manifest') {
      return void sendJson(res, 200, await getManifest());
    }

    if (action === 'row') {
      const type = param('type');
      const id = param('id');
      const genre = param('genre').slice(0, 60);
      const skipRaw = param('skip');
      const skip = skipRaw ? Number(skipRaw) : 0;
      if (!CATALOG_TYPE_RE.test(type) || !CATALOG_ID_RE.test(id) || !Number.isInteger(skip) || skip < 0 || skip > 5000) {
        return void sendApiError(res, 400, 'bad_request');
      }
      return void sendJson(res, 200, await getRow({ type, id, genre: genre || undefined, skip: skip || undefined }));
    }

    if (action === 'search') {
      const q = param('q').trim().slice(0, 100);
      if (q.length < 2) return void sendApiError(res, 400, 'bad_request');
      return void sendJson(res, 200, await search(q));
    }

    if (action === 'meta') {
      const type = param('type');
      const id = param('id');
      if (!CATALOG_TYPE_RE.test(type) || !CATALOG_ID_RE.test(id)) return void sendApiError(res, 400, 'bad_request');
      return void sendJson(res, 200, await getMeta(type, id));
    }

    if (action === 'malscore') {
      const id = param('id');
      if (!/^\d{1,10}$/.test(id)) return void sendApiError(res, 400, 'bad_request');
      return void sendJson(res, 200, await fetchMalScore(id));
    }

    sendApiError(res, 404, 'not_found');
  } catch (err) {
    if (err instanceof CatalogUnavailableError) return void sendApiError(res, 502, 'catalog_unavailable');
    console.error('[Catálogo] Erro:', (err as Error)?.message);
    sendApiError(res, 500, 'internal');
  }
}
