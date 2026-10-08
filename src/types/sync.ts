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
}

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
    };

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
      type: 'error';
      message: string;
      code?: 'kicked' | 'banned' | string;
    };
