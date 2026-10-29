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
 * Transmissão que o servidor diz ser minha mas que esta página não está publicando: o Host recarregou a página (ou
 * abriu outra aba) e o publicador morreu com a página antiga. Deve ser encerrada, senão a sala fica "ao vivo" sem imagem.
 */
export function isOwnOrphan(screen: RoomScreen | null, myId: string, hasLocalSession: boolean): boolean {
  return Boolean(screen && screen.hostId === myId && !hasLocalSession);
}
