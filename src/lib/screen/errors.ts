import { apiErrorMessage, t } from '../i18n';

/** Frase pronta para a interface: código de erro do servidor (HTTP ou WebSocket) -> texto traduzido; senão a mensagem dele. */
export function screenErrorText(code: string | undefined, message: string): string {
  return apiErrorMessage(code, message);
}

export const screenTimeoutText = () => t('O servidor não confirmou a transmissão.');
export const screenCancelledText = () => t('Você cancelou a seleção da tela.');
export const screenFailedText = () => t('Não foi possível iniciar a transmissão.');

/**
 * O usuário fechou o seletor de tela do navegador (não é falha). `NotAllowedError` também vem de bloqueio do sistema
 * operacional (gravação de tela no macOS) ou de política: esses são falhas de verdade e a pessoa precisa saber.
 */
export function isPickerCancel(e: unknown): boolean {
  const { name, message } = (e ?? {}) as { name?: string; message?: string };
  if (name === 'AbortError') return true;
  return name === 'NotAllowedError' && !/system|policy|disallowed/i.test(message ?? '');
}
