import { Chapter, SubtitleTrack, AudioTrackOption } from './media';

export type MemberPlaybackState = 'waiting' | 'loading' | 'ready' | 'playing' | 'paused' | 'stalled';

export interface RoomMember {
  id: string;
  username: string;
  avatarUrl?: string;
  platform?: 'discord' | 'web';
  isHost: boolean;
  ready: boolean;
  state: MemberPlaybackState;
  currentTime: number;
  ping: number;
}

export interface RoomMedia {
  generation: number;
  url: string;
  title: string;
  duration: number;
  parsedTorrent?: any;
  chapters?: Chapter[];
  subtitles?: SubtitleTrack[];
  audioTracks?: AudioTrackOption[];
  /** Quem enviou o link (o servidor preenche): só essa pessoa o vê inteiro, os outros recebem um id opaco. */
  ownerId?: string;
  /** Identidade estável do vídeo (`ih:`/`vh:`, sem o link) para os outros reaproveitarem o cache de legendas e fontes. */
  fingerprint?: string;
}

/** Item da fila (playlist) da sala. A mídia só é resolvida (faixas, legendas) quando o Host toca o item. */
export interface PlaylistItem {
  id: string;
  url: string;
  title: string;
  mimeType?: string;
  fingerprint?: string;
  addedById: string;
  addedBy: string;
}

export const PLAYLIST_MAX_ITEMS = 50;

/** Chave para saber se dois links da fila são o mesmo vídeo (ignora espaços e o #fragmento). */
export const playlistUrlKey = (url: string) => url.trim().replace(/#.*$/, '');

export interface RoomPlaybackState {
  playing: boolean;
  position: number;
  rate: number;
  updatedAt: number; // Timestamp do servidor em ms
}

export interface BannedMember {
  userId: string;
  username: string;
  avatarUrl?: string;
  platform?: 'discord' | 'web';
  bannedAt: number;
}

/**
 * Arquitetura de Autoridade da Sala (Watch Party):
 *
 * 1. PLAYBACK GLOBAL (Autoritativo do Host):
 *    - Posição da timeline (`position`), estado de reprodução (`playing`) e velocidade (`rate`)
 *      são rigidamente autoritativos do Host da sala.
 *    - O servidor calcula a progressão contínua da timeline e sincroniza todos os espectadores.
 *    - Heartbeats (`client:heartbeat`) transportam apenas telemetria/liveness e NUNCA mutam a timeline global da sala.
 *
 * 2. FAIXAS (a sala só conhece QUAIS existem):
 *    - `RoomMedia.audioTracks` e `RoomMedia.subtitles` são metadados compartilhados: as faixas que o arquivo possui.
 *    - Qual áudio/legenda cada pessoa escolheu é estado LOCAL e nunca passa pelo servidor.
 *      Cada espectador seleciona seu áudio (ex: Japonês original vs Português dublado) e sua legenda de forma individual.
 *
 * Resumo: Playback = autoritativo do Host · Faixas disponíveis = metadado compartilhado · Faixa selecionada = estado local.
 */

export interface RoomState {
  roomId: string;
  hostId: string;
  media: RoomMedia | null;
  /** Fila de vídeos a tocar em seguida (qualquer membro adiciona; o Host controla a ordem). */
  playlist?: PlaylistItem[];
  /** Estado de playback global autoritativo (ditado pelo Host) */
  playback: RoomPlaybackState;
  members: RoomMember[];
  bannedMembers?: BannedMember[];
}

export interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  avatarUrl?: string;
  text: string;
  timestamp: number;
  isSystem?: boolean;
}

// Mensagens Cliente -> Servidor
export type ClientMessage =
  | {
      type: 'room:join';
      roomId: string;
      user: {
        id: string;
        username: string;
        avatarUrl?: string;
        platform?: 'discord' | 'web';
      };
    }
  | {
      type: 'room:leave';
    }
  | {
      type: 'media:set';
      media: {
        url: string;
        title: string;
        duration: number;
        parsedTorrent?: any;
        chapters?: Chapter[];
        subtitles?: SubtitleTrack[];
        audioTracks?: AudioTrackOption[];
        fingerprint?: string;
      };
      initialPosition?: number;
    }
  | {
      type: 'playback:play';
      position: number;
    }
  | {
      type: 'playback:pause';
      position: number;
    }
  | {
      type: 'playback:seek';
      position: number;
    }
  | {
      type: 'playback:rate';
      rate: number;
    }
  | {
      type: 'playback:timeline';
      position: number;
      rate?: number;
    }
  | {
      type: 'client:readiness';
      ready: boolean;
      state: MemberPlaybackState;
      currentTime: number;
    }
  | {
      type: 'client:heartbeat';
      clientTime: number;
      currentTime: number;
      state: MemberPlaybackState;
    }
  | {
      type: 'room:transfer_host';
      newHostId: string;
    }
  | {
      type: 'room:kick';
      targetUserId: string;
    }
  | {
      type: 'room:ban';
      targetUserId: string;
    }
  | {
      type: 'room:unban';
      targetUserId: string;
    }
  | {
      type: 'user:update';
      username: string;
      avatarUrl?: string;
    }
  | {
      type: 'chat:send';
      text: string;
    }
  | {
      type: 'playlist:add';
      url: string;
      title: string;
      mimeType?: string;
      fingerprint?: string;
    }
  | {
      type: 'playlist:remove';
      itemId: string;
    }
  | {
      type: 'playlist:move';
      itemId: string;
      /** Um passo para cima/baixo (teclado) ... */
      direction?: 'up' | 'down';
      /** ... ou a posição final (arrastar e soltar). */
      toIndex?: number;
    }
  | {
      /** O Host tirou o item da fila para tocá-lo (o cliente do Host carrega a mídia em seguida). */
      type: 'playlist:take';
      itemId: string;
    }
  | {
      /** O Host informa os capítulos do vídeo atual assim que o player os lê (no `media:set` ainda não se sabe). */
      type: 'media:chapters';
      /** URL do vídeo a que os capítulos pertencem (descarta o que chegar depois de uma troca de vídeo). */
      url: string;
      chapters: Chapter[];
    }
  | {
      /** Voto (ou retirada do voto) para pular um capítulo (abertura, encerramento, resumo). Só quem não é Host vota. */
      type: 'skip:vote';
      /** Início e fim do capítulo, como o Host os informou em `media:set` (o servidor confere). */
      start: number;
      target: number;
      vote: boolean;
    };

/** Votação em andamento para pular um capítulo: passa quando `votes` chega a `needed` (mais da metade da sala). */
export interface SkipVoteState {
  start: number;
  target: number;
  votes: number;
  needed: number;
  /** IDs (sem o sufixo de aba) de quem já votou. */
  voters: string[];
}

// Mensagens Servidor -> Cliente
export type ServerMessage =
  | {
      type: 'room:state';
      state: RoomState;
      assignedUserId?: string;
      /** Token de sessão do membro, usado em /api/* (proxy, legendas, envio). */
      accessToken?: string;
    }
  | {
      type: 'playlist:update';
      playlist: PlaylistItem[];
    }
  | {
      type: 'room:bans_update';
      bannedMembers: BannedMember[];
    }
  | {
      type: 'playback:sync';
      playback: RoomPlaybackState;
      action: 'play' | 'pause' | 'seek' | 'rate';
      triggeredBy: string;
      username: string;
    }
  | {
      type: 'media:sync';
      media: RoomMedia | null;
      generation: number;
      triggeredBy: string;
      username: string;
    }
  | {
      type: 'members:update';
      members: RoomMember[];
      hostId: string;
    }
  | {
      type: 'chat:message';
      message: ChatMessage;
    }
  | {
      type: 'server:heartbeat_ack';
      clientTime: number;
      serverTime: number;
    }
  | {
      type: 'playback:timeline';
      position: number;
      rate?: number;
      updatedAt: number;
    }
  | {
      /** Estado da votação para pular (null = nenhuma em andamento). */
      type: 'skip:votes';
      skip: SkipVoteState | null;
    }
  | {
      /** A sala aprovou pular: só o Host recebe, e é o player dele que faz o seek. */
      type: 'skip:passed';
      start: number;
      target: number;
    }
  | {
      type: 'error';
      message: string;
      code?: 'kicked' | 'banned' | string;
    };
