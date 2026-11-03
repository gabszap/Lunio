import type { RoomScreen, ScreenQualityId } from '../../types/screen';
import type { ScreenKeyMaterial } from './wire';

/**
 * O que os coordenadores da transmissão usam da sala (o `syncManager` implementa). Existe para os coordenadores serem
 * testados sem rede e para não dependerem do cliente WebSocket inteiro.
 */
export interface ScreenSignals {
  getScreen(): RoomScreen | null;
  getUserId(): string;
  /** Avisa quando a transmissão da sala muda. Não repete o valor atual: quem precisa dele lê `getScreen()`. */
  subscribeScreen(listener: (screen: RoomScreen | null) => void): () => void;
  /** Reentrega TODAS as chaves guardadas (em ordem de época) ao se inscrever, e depois cada chave nova. */
  subscribeScreenKey(listener: (key: ScreenKeyMaterial) => void): () => void;
  subscribeScreenRotate(listener: () => void): () => void;
  subscribeError(listener: (message: string, code?: string) => void): () => void;
  emitScreenStart(quality: ScreenQualityId): void;
  emitScreenLive(): void;
  emitScreenStop(): void;
  emitScreenKey(key: ScreenKeyMaterial): void;
  emitScreenUsage(bytes: number): void;
  /** Quem assiste avisa a sala que começou/parou (o Host vê a lista de quem está assistindo). */
  emitScreenWatching(watching: boolean): void;
}
