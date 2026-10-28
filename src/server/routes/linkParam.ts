import type { IncomingMessage, ServerResponse } from 'node:http';
import { getAccess } from '../gate';
import { isExemptFromOpaque, isLinkId, linkIdFor } from '../links';
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

/**
 * Identidade do vídeo para os nomes de cache (legendas, fontes, HLS). Quem tem o link e quem tem só o id calculam fingerprints diferentes
 * (`url:<link>` x `url:lk_…`), o que faria o servidor extrair tudo duas vezes para a mesma sala. Numa sala, quando o cliente não trouxe uma
 * identidade própria do vídeo (`ih:`/`vh:`), vale uma só, derivada do link da sala: `link:<id>`.
 */
export function sharedFingerprint(req: IncomingMessage, realUrl: string | null | false, clientFingerprint: string | undefined): string | undefined {
  const access = getAccess(req);
  if (!realUrl || access?.kind !== 'room' || !access.roomId) return clientFingerprint;
  if (clientFingerprint && !clientFingerprint.startsWith('url:')) return clientFingerprint;
  if (isExemptFromOpaque(realUrl)) return clientFingerprint;
  return `link:${linkIdFor(access.roomId, realUrl)}`;
}
