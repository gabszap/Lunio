import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendApiError, sendJson } from '../http';
import { resolvedUrlCache } from '../media/resolver';
import { cooldownRemainingMs, hostOf } from '../media/upstreamGate';

/**
 * GET /api/upstream?url=… — o provedor deste vídeo limitou os pedidos agora (429)? O player consulta quando a
 * reprodução falha para dizer "o provedor limitou" em vez de um erro de rede genérico. Não faz nenhum pedido ao
 * provedor (já está limitando): só olha o que o servidor anotou do host de origem e do CDN já resolvido.
 */
export function handleUpstreamStatus(req: IncomingMessage, res: ServerResponse) {
  const target = new URL(req.url || '', 'http://localhost').searchParams.get('url') ?? '';
  if (!/^https?:\/\//i.test(target)) {
    sendApiError(res, 400, 'bad_request', 'Parâmetro url ausente ou inválido.');
    return;
  }

  const hosts = new Set([hostOf(target)]);
  const resolved = resolvedUrlCache.get(target);
  if (resolved) hosts.add(hostOf(resolved));

  let host = '';
  let remainingMs = 0;
  for (const h of hosts) {
    const left = cooldownRemainingMs(h);
    if (left > remainingMs) {
      remainingMs = left;
      host = h;
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, { limited: remainingMs > 0, host: remainingMs > 0 ? host : '', retryAfterSec: Math.ceil(remainingMs / 1000) });
}
