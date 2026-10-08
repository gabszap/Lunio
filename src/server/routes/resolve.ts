import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendApiError } from '../http';
import { isBlockedError } from '../security';
import { resolveFinalCdnUrl } from '../media/resolver';

/** GET /api/resolve?url=… — resolve o redirecionamento do Torrentio/debrid até a CDN. */
export async function handleResolve(req: IncomingMessage, res: ServerResponse) {
  try {
    const reqUrl = new URL(req.url || '', 'http://localhost');
    const targetUrl = reqUrl.searchParams.get('url');
    if (!targetUrl) {
      sendApiError(res, 400, 'bad_request', 'Parâmetro url ausente.');
      return;
    }
    const finalUrl = await resolveFinalCdnUrl(targetUrl);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ cdnUrl: finalUrl }));
  } catch (e: any) {
    if (isBlockedError(e)) {
      sendApiError(res, 403, 'url_blocked');
      return;
    }
    console.error('[Resolver] Erro:', e?.message);
    sendApiError(res, 500, 'internal');
  }
}
