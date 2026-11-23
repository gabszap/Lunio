import { Chapter, SubtitleTrack, AudioTrackOption } from './media';
import type { RoomScreen, ScreenQualityId } from './screen';

export type MemberPlaybackState = 'waiting' | 'loading' | 'ready' | 'playing' | 'paused' | 'stalled';

export type RoomVisibility = 'public' | 'private';

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
  /** Está assistindo à transmissão de tela agora (informado pelo servidor a todos; vale só durante a transmissão). */
  watchingScreen?: boolean;
  /** Quanto este membro está atrás do Host (ms; negativo = adiantado), medido pelo servidor. Só com a sala tocando. */
  behindMs?: number;
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
export const REQUESTS_MAX_ITEMS = 30;

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
  /** Nome personalizável definido pelo Host (opcional). */
  name?: string;
  /** Sala pública (entra com o link) ou privada (trancada ou com senha). */
  visibility?: RoomVisibility;
  /** Se a sala privada exige senha para entrar (o hash nunca vai ao cliente). */
  hasPassword?: boolean;
  /** Pausa automaticamente para todos se algum membro travar (buffering) e retoma quando voltar. */
  autoPauseOnBuffer?: boolean;
  /** Timestamp (ms) de criação da sala no servidor (para o cronômetro de duração). */
  createdAt?: number;
  media: RoomMedia | null;
  /** Fila de vídeos a tocar em seguida (só o Host adiciona; espectadores enviam Pedidos). */
  playlist?: PlaylistItem[];
  /** Pedidos sugeridos por espectadores aguardando aprovação do Host. */
  requests?: PlaylistItem[];
  /** Estado de playback global autoritativo (ditado pelo Host) */
  playback: RoomPlaybackState;
  members: RoomMember[];
  bannedMembers?: BannedMember[];
  /** Transmissão de tela em andamento (só em memória; a chave de criptografia nunca vem aqui). */
  screen?: RoomScreen | null;
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
      password?: string;
      /** Token assinado da sala emitido anteriormente (prova reconexão legítima em salas privadas/trancadas). */
      accessToken?: string;
      user: {
        id: string;
        username: string;
        avatarUrl?: string;
        platform?: 'discord' | 'web';
      };
    }
  | {
      type: 'room:settings';
      name?: string;
      visibility?: RoomVisibility;
      /** String não vazia define/altera a senha; `null` remove a senha; `undefined` mantém a atual. */
      password?: string | null;
      autoPauseOnBuffer?: boolean;
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
      /** Geração da mídia do player. Clientes anteriores podem omitir o campo. */
      generation?: number;
    }
  | {
      type: 'client:heartbeat';
      clientTime: number;
      currentTime: number;
      /** Ida e volta até o servidor medida por quem envia (ms); só vai depois da primeira medição. */
      rtt?: number;
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
      /** Espectador sugere um vídeo para o Host aprovar. */
      type: 'request:add';
      url: string;
      title: string;
      mimeType?: string;
      fingerprint?: string;
    }
  | {
      /** Autor cancela o próprio pedido ou o Host recusa qualquer pedido. */
      type: 'request:remove';
      itemId: string;
    }
  | {
      /** Host aprova o pedido para a fila (ou para tocar imediatamente com `playNow: true`). */
      type: 'request:approve';
      itemId: string;
      playNow?: boolean;
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
    }
  | {
      /** O Host começa a transmitir a tela com a qualidade escolhida. */
      type: 'screen:start';
      quality: ScreenQualityId;
    }
  | {
      /** O Host já está publicando no relay: os espectadores podem assistir. */
      type: 'screen:live';
    }
  | {
      type: 'screen:stop';
    }
  | {
      /** Chave AES-256 (base64) da transmissão e sua época; o servidor só repassa aos membros atuais. */
      type: 'screen:key';
      epoch: number;
      key: string;
    }
  | {
      /** Total de bytes de vídeo+áudio publicados até agora (medidor de uso). */
      type: 'screen:usage';
      bytes: number;
    }
  | {
      /** O Host muda a qualidade da transmissão que já está no ar. */
      type: 'screen:quality';
      quality: ScreenQualityId;
    }
  | {
      /** Quem não é o Host avisa que começou ou parou de assistir à transmissão (o servidor repassa a lista só ao Host). */
      type: 'screen:watching';
      watching: boolean;
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
      type: 'requests:update';
      requests: PlaylistItem[];
    }
  | {
      /** Enviado apenas ao Host quando ele aprova um pedido com `playNow: true`. */
      type: 'request:play';
      item: PlaylistItem;
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
      /** Transmissão de tela da sala (null = nenhuma). */
      type: 'screen:state';
      screen: RoomScreen | null;
    }
  | {
      type: 'screen:key';
      epoch: number;
      key: string;
    }
  | {
      /** Alguém saiu ou foi expulso: o Host da transmissão deve girar a chave. */
      type: 'screen:rotate_key';
    }
  | {
      /** Quem está assistindo à transmissão agora. Só o Host da transmissão recebe. */
      type: 'screen:viewers';
      viewers: Array<{ id: string; username: string }>;
    }
  | {
      type: 'room:settings_update';
      name?: string;
      visibility: RoomVisibility;
      hasPassword: boolean;
      autoPauseOnBuffer: boolean;
    }
  | {
      type: 'error';
      message: string;
      code?: 'kicked' | 'banned' | 'password_required' | 'wrong_password' | 'room_locked' | 'rate_limited' | string;
    };
