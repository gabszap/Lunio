/**
 * "Seus envios recentes" (ENVIOS-REDIS.md, 4.6): o navegador guarda o `claim` assinado dos últimos
 * envios para poder reabri-los depois, com a sala encerrada. Lista longa nem serve: no máximo 5.
 * Limpar o navegador apaga a lista — o arquivo continua no servidor até o prazo, só não há claim para reabrir.
 */

export interface RecentUpload {
  /** Id do envio no servidor (`/api/uploads/<id>/<name>`). */
  id: string;
  name: string;
  size: number;
  /** Prova de dono assinada pelo servidor, devolvida no fim do envio. */
  claim: string;
  /** Quando o envio terminou (para a lista e para sumir o mais velho). */
  at: number;
  /** Quando o claim (e o possível reabrir) vence, lido de dentro do claim. Ausente em registros antigos. */
  exp?: number;
}

/** Lê o `exp` de dentro do claim assinado (base64url do payload antes do ponto). */
export function claimExpiry(claim: string): number | undefined {
  const body = claim.split('.')[0];
  if (!body) return undefined;
  try {
    const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined; // claim malformado: sem prazo à vista, o servidor recusa no reabrir
  }
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

export function forgetRecentUpload(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadRecentUploads().filter((r) => r.id !== id)));
  } catch {
    // sem onde guardar: nada a esquecer
  }
}
