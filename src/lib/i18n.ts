import { useSyncExternalStore } from 'react';
import { EN } from './i18n.en';

/**
 * i18n leve. O texto-fonte (português) é a chave: `t('Criar sala')`. Em inglês procura em `i18n.en.ts`;
 * se não houver tradução, mostra o próprio português (nunca quebra a tela). Variáveis: `t('Faltam {n} min', { n: 3 })`.
 * O teste `i18n.test.ts` falha se algum `t('…')` do código não tiver tradução em inglês.
 */

export type Lang = 'pt' | 'en';
export const LANGS: Array<{ code: Lang; label: string }> = [
  { code: 'pt', label: 'Português' },
  { code: 'en', label: 'English' },
];

const STORAGE_KEY = 'lunio_lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'pt' || saved === 'en') return saved;
  } catch {
    // sem localStorage
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return nav.toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

let current: Lang = detect();
const listeners = new Set<() => void>();

function apply(lang: Lang) {
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
}
apply(current);

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang) {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ok: vale só até recarregar
  }
  apply(lang);
  for (const l of listeners) l();
}

/** Re-renderiza o componente quando o idioma muda (a troca é feita na Home). */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current
  );
}

export function translate(lang: Lang, text: string, vars?: Record<string, string | number>): string {
  let out = lang === 'en' ? EN[text] ?? text : text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
  return out;
}

/** Marca um texto traduzível definido fora de um componente (constante de módulo); quem exibe chama `t(valor)`. */
export const msg = (text: string) => text;

export function t(text: string, vars?: Record<string, string | number>): string {
  return translate(current, text, vars);
}

/** Mensagens que o servidor devolve por código (`{ error, code }`): traduzidas aqui; o texto do servidor é o plano B. */
const API_ERRORS: Record<string, string> = {
  bad_request: msg('Pedido inválido.'),
  unauthorized: msg('Sessão ausente ou expirada. Recarregue a página.'),
  forbidden: msg('Você não tem permissão para isso.'),
  rate_limited: msg('Muitos pedidos. Tente de novo em instantes.'),
  busy: msg('O servidor está ocupado. Tente de novo em instantes.'),
  url_blocked: msg('Esse endereço não pode ser acessado pelo servidor.'),
  upstream_failed: msg('Não foi possível acessar o vídeo de origem.'),
  too_large: msg('Arquivo grande demais.'),
  quota_exceeded: msg('O servidor não tem mais espaço para envios.'),
  upload_in_progress: msg('Já existe um envio em andamento nesta sala.'),
  not_host: msg('Só o Host da sala pode enviar arquivos.'),
  internal: msg('Erro inesperado no servidor.'),
};

export function apiErrorMessage(code: string | undefined, fallback?: string): string {
  const known = code ? API_ERRORS[code] : undefined;
  return known ? t(known) : fallback || t('Erro inesperado no servidor.');
}
