import type { CatalogSeriesContext, MediaPayload } from '../../types/media';

/** "room" cria (ou reaproveita) uma sala como Host; "solo" só toca aqui. */
export type CommitMode = 'room' | 'solo';

export interface CommitOptions {
  /** Guarda o link em "Recentes". */
  recent?: boolean;
  /** Série de onde o vídeo veio (menu de episódios do player). Sem ela, o contexto da série anterior é descartado. */
  seriesContext?: CatalogSeriesContext;
}

export type SourceCommit = (payload: MediaPayload, mode: CommitMode, options?: CommitOptions) => void;
