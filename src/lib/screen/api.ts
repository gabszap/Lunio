import type { ScreenQualityId } from '../../types/screen';
import { apiFetch } from '../access';
import { apiErrorMessage } from '../i18n';

export interface ScreenToken {
  /** Endereço do relay COM o token: nunca vai para log, console nem mensagem de erro. */
  url: string;
  path: string;
  /** `true` só para o Host que transmite (token de publicar); os demais recebem o de só assistir. */
  publish: boolean;
  quality: ScreenQualityId;
  sessionId: string;
}

export interface ScreenApi {
  fetchToken(): Promise<ScreenToken>;
  isEnabled(): Promise<boolean>;
}

const ENABLED_TTL_MS = 60_000;

let enabledCache: { at: number; value: boolean } | null = null;

export const screenApi: ScreenApi = {
  async fetchToken() {
    const res = await apiFetch('/api/screen/token', { method: 'POST' });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      // corpo ilegível: cai no erro genérico abaixo
    }
    if (!res.ok || !body || typeof body.url !== 'string') {
      // Só a frase do código: o corpo de uma resposta de sucesso é segredo, e o de erro não precisa aparecer
      throw new Error(apiErrorMessage(body?.code));
    }
    return body as ScreenToken;
  },

  async isEnabled() {
    const now = Date.now();
    if (enabledCache && now - enabledCache.at < ENABLED_TTL_MS) return enabledCache.value;
    try {
      const res = await apiFetch('/api/status');
      // Falha (rede, 429 do limite do /api/status…) não é resposta: não fica guardada, senão o botão sumia por 1 min
      if (!res.ok) return false;
      const body: any = await res.json();
      const value = body?.screen?.enabled === true;
      enabledCache = { at: now, value };
      return value;
    } catch {
      return false;
    }
  },
};
