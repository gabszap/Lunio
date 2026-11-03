import type { RoomScreen } from '../../types/screen';

export type ScreenUnavailableReason = 'discord' | 'not-connected' | 'not-host' | 'unsupported' | 'disabled';

/** O botão "Transmitir a tela" aparece? Só para o Host de uma sala, em navegador capaz, com a flag do servidor ligada. */
export function screenAvailability(a: {
  discord: boolean;
  capabilities: { host: boolean };
  enabled: boolean;
  isHost: boolean;
  connected: boolean;
}): { canBroadcast: boolean; why: ScreenUnavailableReason | null } {
  const why: ScreenUnavailableReason | null = a.discord
    ? 'discord'
    : !a.connected
      ? 'not-connected'
      : !a.isHost
        ? 'not-host'
        : !a.capabilities.host
          ? 'unsupported'
          : !a.enabled
            ? 'disabled'
            : null;
  return { canBroadcast: why === null, why };
}

/**
 * A opção "Compartilhar sua tela" do menu da Home (ainda sem sala): `available` liga, `checking` espera a resposta do
 * servidor (`enabled` ainda desconhecido: `null`), `unavailable` fica desligada. Quem não pode transmitir nunca espera.
 */
export function screenMenuState(a: { discord: boolean; hostCapable: boolean; enabled: boolean | null }): 'available' | 'checking' | 'unavailable' {
  if (a.discord || !a.hostCapable) return 'unavailable';
  if (a.enabled === null) return 'checking';
  return a.enabled ? 'available' : 'unavailable';
}

/**
 * Transmissão que o servidor diz ser minha mas que esta página não está publicando: o Host recarregou a página (ou
 * abriu outra aba) e o publicador morreu com a página antiga. Deve ser encerrada, senão a sala fica "ao vivo" sem imagem.
 */
export function isOwnOrphan(screen: RoomScreen | null, myId: string, hasLocalSession: boolean): boolean {
  return Boolean(screen && screen.hostId === myId && !hasLocalSession);
}
