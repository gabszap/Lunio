import type { IncomingMessage, ServerResponse } from 'node:http';
import { getAccess } from '../gate';
import { isLinkId } from '../links';
import { roomManager } from '../roomServer';
import { sendApiError } from '../http';

/**
 * Troca o id opaco (`lk_…`) pelo link de verdade, na sala do token da chamada. Link comum passa direto.
 * Id que a sala não conhece (de outra sala, de vídeo que já saiu, ou sessão solo) vira 404 `link_expired` e devolve `false`
 * (a resposta já foi dada); sem o parâmetro, `null`.
 */
export function expandLink(req: IncomingMessage, res: ServerResponse, raw: string | null): string | null | false {
  if (!raw || !isLinkId(raw)) return raw;
  const access = getAccess(req);
  const url = access?.kind === 'room' && access.roomId ? roomManager.resolveLink(access.roomId, raw) : null;
  if (!url) {
    sendApiError(res, 404, 'link_expired');
    return false;
  }
  return url;
}

/** `?url=` da chamada, já com o id trocado pelo link. */
export function urlParam(req: IncomingMessage, res: ServerResponse, reqUrl: URL): string | null | false {
  return expandLink(req, res, reqUrl.searchParams.get('url'));
}
