/**
 * "Seus envios recentes" (ENVIOS-REDIS.md, 4.6): o navegador guarda o `claim` assinado dos últimos
 * envios para poder reabri-los depois, com a sala encerrada. Lista longa nem serve: no máximo 5.
 * Limpar o navegador apaga a lista — o arquivo continua no servidor até o prazo, só não há claim para reabrir.
 */

import { apiFetch } from './access';

export interface RecentUpload {
  /** Id do envio no servidor (`/api/uploads/<id>/<name>`). */
  id: string;
  name: string;
  size: number;
  /** Prova de dono assinada pelo servidor, devolvida no fim do envio. */
  claim: string;
  /** Quando o envio terminou (para a lista e para sumir o mais velho). */
  at: number;
  /**
   * Quando o arquivo sai do servidor, como o servidor informou (reabrir e a verificação da lista). `null`: ainda não se
   * sabe (a sala do envio está aberta); ausente: nunca perguntamos. O claim não serve de relógio: vale 7 dias e o arquivo
   * tem prazo próprio, que conta do fechamento da sala.
   */
  expiresAt?: number | null;
}

const KEY = 'lunio.recentUploads';
const MAX = 5;

export function loadRecentUploads(): RecentUpload[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as RecentUpload[];
    return Array.isArray(raw)
      ? raw.filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string' && typeof r.claim === 'string')
      : [];
  } catch {
    return [];
  }
}

export function rememberRecentUpload(rec: RecentUpload): void {
  const list = loadRecentUploads().filter((r) => r.id !== rec.id); // reenvio substitui; mesmo envio não duplica
  list.unshift(rec);
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); // a mais velha sai
  } catch {
    // sem espaço no localStorage (modo privado, cookies bloqueados): a lista vive menos, tudo bem
  }
}

/** Atualiza um envio da lista (claim novo, prazo) sem mexer na ordem. */
export function updateRecentUpload(id: string, patch: Partial<RecentUpload>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadRecentUploads().map((r) => (r.id === id ? { ...r, ...patch } : r))));
  } catch {
    // sem onde guardar: a lista fica como estava
  }
}

/**
 * Pergunta ao servidor o que ainda existe e quando vence (uma só chamada para a lista toda): o que sumiu da lista sai,
 * o prazo real fica guardado. Falha de rede deixa tudo como está. Claim que o servidor diz inválido também fica: quem
 * decide é o reabrir, com a frase certa.
 */
export async function refreshRecentUploads(): Promise<void> {
  const list = loadRecentUploads();
  if (list.length === 0) return;
  try {
    const res = await apiFetch('/api/uploads/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: list.map((r) => ({ id: r.id, claim: r.claim })) }),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { items?: Array<{ id: string; state: string; expiresAt: number | null }> };
    for (const item of body.items ?? []) {
      if (item.state === 'gone') forgetRecentUpload(item.id);
      else if (item.state === 'ok') updateRecentUpload(item.id, { expiresAt: item.expiresAt });
    }
  } catch {
    // sem rede: a lista continua como estava
  }
}

/** Quanto falta para o envio vencer, na unidade que cabe no texto (horas; abaixo de 1 h, minutos). Sem prazo conhecido: null. */
export function describeExpiry(expiresAt: number | null | undefined, now: number): { unit: 'h' | 'min' | 'now'; value: number } | null {
  if (typeof expiresAt !== 'number') return null;
  const minutes = Math.floor((expiresAt - now) / 60_000);
  if (minutes >= 60) return { unit: 'h', value: Math.floor(minutes / 60) };
  if (minutes >= 1) return { unit: 'min', value: minutes };
  return { unit: 'now', value: 0 };
}

export function forgetRecentUpload(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadRecentUploads().filter((r) => r.id !== id)));
  } catch {
    // sem onde guardar: nada a esquecer
  }
}
