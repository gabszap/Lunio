import type { CatalogSeriesContext, MediaPayload } from '../../types/media';
import type { RoomInitialSettings } from '../../types/sync';
import type { ContinueRef } from '../../lib/continueWatching';

export type SourceStep = 'upload' | 'torrent' | 'youtube' | 'drive' | 'screen' | 'stream';

/** "room" cria (ou reaproveita) uma sala como Host; "solo" só toca aqui. */
export type CommitMode = 'room' | 'solo';

export interface CommitOptions {
  /** Guarda o link em "Recentes". */
  recent?: boolean;
  /** Série de onde o vídeo veio (menu de episódios do player). Sem ela, o contexto da série anterior é descartado. */
  seriesContext?: CatalogSeriesContext;
  /** Título do catálogo que toca (entra em "Continuar assistindo"); sem ele, o vídeo não é guardado lá. */
  continueRef?: ContinueRef;
  /** Configurações iniciais ao criar uma nova sala pelo fluxo de mídia (ex.: título do Catálogo). */
  initialRoomSettings?: RoomInitialSettings;
}

export type SourceCommit = (payload: MediaPayload, mode: CommitMode, options?: CommitOptions) => void;
