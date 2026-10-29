import { apiErrorMessage, t } from '../i18n';

/** Frase pronta para a interface: código de erro do servidor (HTTP ou WebSocket) -> texto traduzido; senão a mensagem dele. */
export function screenErrorText(code: string | undefined, message: string): string {
  return apiErrorMessage(code, message);
}

export const screenTimeoutText = () => t('O servidor não confirmou a transmissão.');
export const screenCancelledText = () => t('Você cancelou a seleção da tela.');
export const screenFailedText = () => t('Não foi possível iniciar a transmissão.');

/** O usuário fechou o seletor de tela do navegador (não é falha). */
export function isPickerCancel(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}
