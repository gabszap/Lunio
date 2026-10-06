import type { MediaPayload } from '../../types/media';

/** "room" cria (ou reaproveita) uma sala como Host; "solo" só toca aqui. */
export type CommitMode = 'room' | 'solo';

export interface CommitOptions {
  /** Guarda o link em "Recentes". */
  recent?: boolean;
}

export type SourceCommit = (payload: MediaPayload, mode: CommitMode, options?: CommitOptions) => void;
