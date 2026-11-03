import crypto from 'node:crypto';
import { config } from './config';
import { playlistUrlKey, type PlaylistItem, type RoomMedia } from '../types/sync';
import { uploadIdFromUrl } from './media/uploads';

/**
 * Links de stream opacos. O link do vídeo (tem a chave de debrid de quem o escolheu) só aparece inteiro para quem o enviou; para o resto
 * da sala o servidor troca o link por um id (`lk_…`) e as rotas aceitam o id no lugar do link. Nada fica guardado à parte: a tabela é
 * sempre refeita a partir da mídia e da fila da sala, então o que o Redis já guarda (e o `restore()`) basta.
 */

export const LINK_ID_RE = /^lk_[A-Za-z0-9_-]{22}$/;
export const isLinkId = (value: unknown): value is string => typeof value === 'string' && LINK_ID_RE.test(value);

export interface LinkEntry {
  id: string;
  url: string;
  /** Quem enviou o link (`userId`): é o único que o vê inteiro. */
  ownerId: string;
}

/** O que a tabela precisa de uma sala. */
export interface LinkRoom {
  roomId: string;
  media: Pick<RoomMedia, 'url' | 'ownerId'> | null;
  playlist: Array<Pick<PlaylistItem, 'url' | 'addedById'>>;
}

/** A segunda aba da mesma pessoa tem `<id>_tab####`: vale o id de verdade (mesma regra de `baseUserId`). */
const baseUser = (id: string) => id.replace(/_tab\d{4}$/, '');

const memo = new Map<string, string>();

/** Mesmo link na mesma sala dá sempre o mesmo id; sem o segredo do servidor não dá para adivinhar nem para ligar a outra sala. */
export function linkIdFor(roomId: string, url: string): string {
  const key = `${roomId}\0${playlistUrlKey(url)}`;
  let id = memo.get(key);
  if (!id) {
    id = `lk_${crypto.createHmac('sha256', config.sessionSecret).update(key).digest().subarray(0, 16).toString('base64url')}`;
    if (memo.size > 5000) memo.clear();
    memo.set(key, id);
  }
  return id;
}

/** Fora da troca: o arquivo enviado ao próprio site e o YouTube (os outros precisam do link para tocar e nenhum é segredo). */
export function isExemptFromOpaque(url: string): boolean {
  if (uploadIdFromUrl(url)) return true;
  try {
    const host = new URL(url).hostname.replace(/^www\.|^m\./, '');
    return host === 'youtu.be' || host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com';
  } catch {
    return false;
  }
}

/** Os links da sala que passam pela troca: o da mídia atual e os da fila. */
export function linksOf(room: LinkRoom): LinkEntry[] {
  const out = new Map<string, LinkEntry>();
  // Sem dono conhecido (sala restaurada de uma versão antiga) o link vai como id para todos até alguém o enviar de novo
  const add = (url: string | undefined, ownerId: string | undefined) => {
    if (!url || isExemptFromOpaque(url)) return;
    const id = linkIdFor(room.roomId, url);
    if (!out.has(id)) out.set(id, { id, url, ownerId: ownerId ?? '' });
  };
  add(room.media?.url, room.media?.ownerId);
  for (const item of room.playlist) add(item.url, item.addedById);
  return [...out.values()];
}

/** Id da sala -> link real e dono; `null` se o id não é de nenhum link dela. */
export function resolveLinkId(room: LinkRoom, id: string): LinkEntry | null {
  if (!isLinkId(id)) return null;
  return linksOf(room).find((e) => e.id === id) ?? null;
}

/**
 * Troca, no JSON de uma mensagem, os links que não são de `viewerId` pelos ids. Pega o link em qualquer lugar do texto (`media.url`, `playlist[].url`,
 * `?url=<link>` dentro de legenda), tanto como vem quanto codificado em URL.
 */
export function scrubFor(entries: LinkEntry[], viewerId: string, json: string): string {
  let out = json;
  const viewer = baseUser(viewerId);
  for (const e of entries) {
    if (baseUser(e.ownerId) === viewer) continue;
    for (const form of new Set([JSON.stringify(e.url).slice(1, -1), encodeURIComponent(e.url)])) {
      if (out.includes(form)) out = out.split(form).join(e.id);
    }
  }
  return out;
}
