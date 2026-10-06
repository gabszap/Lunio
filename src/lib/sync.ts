import { discordManager } from './discord';
import { logger } from './logger';
import type {
  ClientMessage,
  ServerMessage,
  RoomState,
  RoomMember,
  RoomMedia,
  ChatMessage,
  MemberPlaybackState,
  BannedMember,
} from '../types/sync';

export interface DriftCorrectionResult {
  drift: number;
  action: 'none' | 'rate_speedup' | 'rate_slowdown' | 'seek';
  targetTime: number;
}

export type SyncStateListener = (state: RoomState | null) => void;
export type PlaybackSyncListener = (
  action: 'play' | 'pause' | 'seek' | 'rate',
  position: number,
  rate: number,
  triggeredBy: string,
  username: string
) => void;
export type MediaSyncListener = (
  media: RoomMedia | null,
  generation: number,
  triggeredBy: string,
  username: string
) => void;
export type TrackSyncListener = (
  audioTrack: string | undefined,
  subtitleTrack: string | undefined,
  triggeredBy: string,
  username: string
) => void;
export type ChatListener = (message: ChatMessage) => void;
export type ErrorListener = (message: string, code?: string) => void;

class SyncManager {
  private ws: WebSocket | null = null;
  private currentRoomId: string = '';
  private roomState: RoomState | null = null;
  private isConnecting: boolean = false;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private messageQueue: ClientMessage[] = [];

  // Previne loop de eco quando comandos remotos são aplicados localmente
  public isApplyingRemoteUpdate: boolean = false;

  // Usuário local
  private user: { id: string; username: string; avatarUrl?: string; platform?: 'discord' | 'web' };

  // Listeners
  private stateListeners = new Set<SyncStateListener>();
  private playbackListeners = new Set<PlaybackSyncListener>();
  private mediaListeners = new Set<MediaSyncListener>();
  private trackListeners = new Set<TrackSyncListener>();
  private chatListeners = new Set<ChatListener>();
  private errorListeners = new Set<ErrorListener>();
  private chatHistory: ChatMessage[] = [];
  private getCurrentTimeCallback: (() => number) | null = null;

  public registerTimeGetter(fn: () => number) {
    this.getCurrentTimeCallback = fn;
  }

  constructor() {
    this.user = this.resolveLocalUser();
  }

  private isPageReload(): boolean {
    try {
      if (typeof performance !== 'undefined') {
        const navEntries = performance.getEntriesByType('navigation');
        if (navEntries.length > 0) {
          return (navEntries[0] as PerformanceNavigationTiming).type === 'reload';
        }
        return (performance as any).navigation?.type === 1;
      }
    } catch {}
    return false;
  }

  private resolveLocalUser(): { id: string; username: string; avatarUrl?: string } {
    const isReload = this.isPageReload();
    let savedId = '';
    let savedUsername = '';
    let savedAvatarUrl: string | undefined;

    try {
      const saved = sessionStorage.getItem('streamplayer_watchparty_user');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.username && !parsed.username.startsWith('Espectador #') && parsed.username !== 'Usuário Local') {
          savedUsername = parsed.username;
        }
        savedAvatarUrl = parsed.avatarUrl;
        // Somente reaproveita o ID se for recarregamento da mesma aba (F5/Reload).
        // Se for nova aba, aba duplicada ou nova janela, gera um ID 100% novo e exclusivo!
        if (isReload && parsed.id) {
          savedId = parsed.id;
        }
      }
    } catch {}

    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const userId = savedId || `usr_${Date.now()}_${randomSuffix}_${Math.random().toString(36).slice(2, 6)}`;
    const username = savedUsername || `Espectador #${randomSuffix}`;

    const isDiscord = discordManager.getState().isEmbedded;
    const user: { id: string; username: string; avatarUrl?: string; platform: 'discord' | 'web' } = {
      id: userId,
      username,
      avatarUrl: savedAvatarUrl,
      platform: isDiscord ? 'discord' : 'web',
    };

    try {
      sessionStorage.setItem('streamplayer_watchparty_user', JSON.stringify(user));
    } catch {}

    return user;
  }

  public hasCustomUsername(): boolean {
    try {
      return sessionStorage.getItem('streamplayer_has_custom_user') === 'true';
    } catch {
      return false;
    }
  }

  public setUserProfile(username: string, avatarUrl?: string) {
    const cleanName = username.trim().slice(0, 32);
    if (!cleanName) return;

    this.user = {
      ...this.user,
      username: cleanName,
      avatarUrl: avatarUrl !== undefined ? avatarUrl : this.user.avatarUrl,
    };
    try {
      sessionStorage.setItem('streamplayer_watchparty_user', JSON.stringify(this.user));
      sessionStorage.setItem('streamplayer_has_custom_user', 'true');
    } catch {}

    // Notifica o servidor imediatamente da mudança de nome
    if (this.isConnected) {
      this.send({
        type: 'user:update',
        username: cleanName,
        avatarUrl: this.user.avatarUrl,
      });
    }
    this.notifyState();
  }

  public getUser() {
    return this.user;
  }

  public getRoomState(): RoomState | null {
    return this.roomState;
  }

  public getRoomId(): string {
    return this.currentRoomId;
  }

  public getChatHistory(): ChatMessage[] {
    return [...this.chatHistory];
  }

  public isRoomHost(): boolean {
    if (!this.currentRoomId || !this.roomState) return true; // Standalone isolado opera como Host próprio
    return this.roomState.hostId === this.user.id;
  }

  public getStatus(): { isConnected: boolean; isConnecting: boolean; isHost: boolean; membersCount: number; roomId: string } {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      isHost: this.isRoomHost(),
      membersCount: this.roomState?.members?.length || 1,
      roomId: this.currentRoomId,
    };
  }

  /**
   * Conecta ao servidor WebSocket da Watch Party
   */
  public connect(customRoomId?: string) {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      if (customRoomId && customRoomId !== this.currentRoomId) {
        this.joinRoom(customRoomId);
      }
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Detecta sala: Discord Voice Channel se disponível, query param ?room= ou customRoomId
    const discordState = discordManager.getState();
    const urlParams = new URLSearchParams(window.location.search);
    const queryRoom = urlParams.get('room');

    // Se estiver no Discord e o canal de voz ainda não estiver resolvido pelo SDK, aguarda a resolução
    if (discordState.isEmbedded && !discordState.channelId && !customRoomId) {
      logger.info('[Sala] Discord: aguardando o canal de voz…');
      this.isConnecting = false;
      return;
    }

    if (customRoomId) {
      this.currentRoomId = customRoomId;
    } else if (queryRoom) {
      this.currentRoomId = queryRoom;
    } else if (discordState.isEmbedded && discordState.channelId) {
      this.currentRoomId = `discord_${discordState.channelId}`;
    } else {
      // Sem sala definida: não conecta automaticamente. Opera em Modo Solo desconectado.
      logger.info('[Sala] Sem sala: assistindo sozinho');
      this.currentRoomId = '';
      this.isConnected = false;
      this.isConnecting = false;
      this.notifyState();
      return;
    }

    this.isConnecting = true;

    // Se no Discord e autenticado, atualiza perfil com dados reais do Discord
    if (discordState.isEmbedded && discordState.user) {
      this.setUserProfile(
        discordState.user.globalName || discordState.user.username,
        discordState.user.avatarUrl
      );
    }

    // Monta URL de WebSocket
    const isHttps = window.location.protocol === 'https:';
    const wsProto = isHttps ? 'wss:' : 'ws:';
    const host = window.location.host;

    // Em Discord Activity, o proxy roteia via /.proxy/api/ws
    const wsPath = discordState.isEmbedded ? '/.proxy/api/ws' : '/api/ws';
    const wsUrl = `${wsProto}//${host}${wsPath}`;

    logger.info(`[Sala] Conectando à sala ${this.currentRoomId}…`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        logger.info('[Sala] Conectado');
        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectAttempts = 0;

        // Entra na sala
        this.send({
          type: 'room:join',
          roomId: this.currentRoomId,
          user: this.user,
        });

        // Envia quaisquer mensagens pendentes na fila (ex: emitMedia antes da conexão abrir)
        while (this.messageQueue.length > 0) {
          const pending = this.messageQueue.shift()!;
          this.send(pending);
        }

        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = (event: any) => {
        if (event && (event.code === 4001 || event.code === 4002)) {
          logger.info(`[Sala] Conexão encerrada pelo servidor (código ${event.code})`);
          this.leaveRoom();
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.reconnectAttempts = 999;
          const msg = event.code === 4002 ? 'Você foi banido desta sala pelo Host.' : 'Você foi expulso da sala pelo Host.';
          for (const listener of this.errorListeners) {
            listener(msg, event.code === 4002 ? 'banned' : 'kicked');
          }
          return;
        }
        this.handleDisconnect(event);
      };

      this.ws.onerror = (err) => {
        logger.warn('[Sala] Erro na conexão:', err);
      };
    } catch (e: any) {
      logger.error('[Sala] Não deu pra abrir a conexão:', e);
      this.handleDisconnect();
    }
  }

  public syncWithDiscord(discordState: import('./discord').DiscordContextState) {
    const urlParams = new URLSearchParams(window.location.search);
    const queryRoom = urlParams.get('room');

    if (discordState.user) {
      this.setUserProfile(
        discordState.user.globalName || discordState.user.username,
        discordState.user.avatarUrl
      );
    }

    if (discordState.isEmbedded && discordState.channelId) {
      // Prioriza a sala informada na URL (?room=...) ou usa o canal de voz do Discord
      const targetRoom = queryRoom || `discord_${discordState.channelId}`;
      if (!this.isConnected && !this.isConnecting) {
        this.connect(targetRoom);
      } else if (this.currentRoomId !== targetRoom && !queryRoom) {
        logger.info(`[Sala] Usando o canal de voz do Discord: ${targetRoom}`);
        this.joinRoom(targetRoom);
      }
    }
  }

  private handleDisconnect(event?: any) {
    this.isConnected = false;
    this.isConnecting = false;
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (event && (event.code === 4001 || event.code === 4002)) {
      this.reconnectAttempts = 999;
      return;
    }

    // Se o usuário não está em nenhuma sala (Modo Solo ou saiu voluntariamente), não tenta reconectar
    if (!this.currentRoomId) {
      return;
    }

    // Reconexão com backoff exponencial (máx 15s)
    const delay = Math.min(15000, 1000 * Math.pow(1.5, this.reconnectAttempts));
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logger.info(`[Sala] Reconectando (tentativa ${this.reconnectAttempts})…`);
      this.connect(this.currentRoomId);
    }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
        const curTime = this.getCurrentTimeCallback ? this.getCurrentTimeCallback() : 0;
        this.send({
          type: 'client:heartbeat',
          clientTime: Date.now(),
          currentTime: Math.max(0, curTime),
          state: 'ready',
        });
      }
    }, 10000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  public joinRoom(roomId: string) {
    this.currentRoomId = roomId;
    if (this.isConnected) {
      this.send({
        type: 'room:join',
        roomId,
        user: this.user,
      });
    } else {
      this.connect(roomId);
    }
  }

  public leaveRoom() {
    if (this.isConnected) {
      this.send({ type: 'room:leave' });
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.currentRoomId = '';
    this.roomState = null;
    this.chatHistory = [];
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      if (typeof window !== 'undefined' && window.location.search) {
        const url = new URL(window.location.href);
        url.searchParams.delete('room');
        window.history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
      }
    } catch {}

    logger.info('[Sala] Você saiu da sala');
    this.notifyState();
  }

  private send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        logger.warn('[Sala] Erro ao enviar para o servidor:', err);
      }
    } else if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.CONNECTING)) {
      this.messageQueue.push(msg);
    }
  }

  private handleMessage(rawData: any) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(rawData);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'room:state': {
        if (msg.assignedUserId && this.user.id !== msg.assignedUserId) {
          this.user = {
            ...this.user,
            id: msg.assignedUserId,
          };
          try {
            sessionStorage.setItem('streamplayer_watchparty_user', JSON.stringify(this.user));
          } catch {}
        }
        const prevMedia = this.roomState?.media;
        const isFirstState = !this.roomState;
        this.roomState = msg.state;
        if (isFirstState) {
          const host = msg.state.members.find((m) => m.isHost);
          logger.info(
            `[Sala] Na sala ${msg.state.roomId}: ${msg.state.members.length} ${msg.state.members.length === 1 ? 'pessoa' : 'pessoas'}, Host: ${host?.username || '—'}${
              host?.id === this.user.id ? ' (você)' : ''
            }`
          );
        }

        // Se a sala já possui uma mídia e este usuário não é o Host, carrega a mídia no espectador!
        if (msg.state.media && !this.isRoomHost()) {
          const isNewMedia = !prevMedia || prevMedia.url !== msg.state.media.url || prevMedia.generation !== msg.state.media.generation;
          if (isNewMedia) {
            logger.info(`[Sala] Vídeo da sala: "${msg.state.media.title}"`);
            for (const listener of this.mediaListeners) {
              listener(msg.state.media, msg.state.media.generation, msg.state.hostId, 'Host');
            }
          }
        }

        this.notifyState();
        break;
      }

      case 'playback:sync': {
        if (!this.roomState) return;
        this.roomState.playback = msg.playback;

        // Notifica listeners para aplicar no player local (se não foi o próprio disparador)
        if (msg.triggeredBy !== this.user.id) {
          const verb: Record<string, string> = { play: 'deu play', pause: 'pausou', seek: 'pulou para', rate: 'mudou a velocidade para' };
          logger.info(
            `[Sala] ${msg.username} ${verb[msg.action] || msg.action} ${
              msg.action === 'rate' ? `${msg.playback.rate}x` : `em ${formatClock(msg.playback.position)}`
            }`
          );
          this.isApplyingRemoteUpdate = true;
          for (const listener of this.playbackListeners) {
            listener(
              msg.action,
              msg.playback.position,
              msg.playback.rate,
              msg.triggeredBy,
              msg.username
            );
          }
          setTimeout(() => {
            this.isApplyingRemoteUpdate = false;
          }, 300);
        }
        this.notifyState();
        break;
      }

      case 'media:sync': {
        if (!this.roomState) return;
        this.roomState.media = msg.media;

        if (msg.triggeredBy !== this.user.id) {
          logger.info(`[Sala] ${msg.username} carregou "${msg.media.title}"`);
          this.isApplyingRemoteUpdate = true;
          for (const listener of this.mediaListeners) {
            listener(msg.media, msg.generation, msg.triggeredBy, msg.username);
          }
          setTimeout(() => {
            this.isApplyingRemoteUpdate = false;
          }, 500);
        }
        this.notifyState();
        break;
      }

      case 'track:sync': {
        if (!this.roomState) return;
        if (msg.audioTrack !== undefined) this.roomState.audioTrack = msg.audioTrack;
        if (msg.subtitleTrack !== undefined) this.roomState.subtitleTrack = msg.subtitleTrack;

        if (msg.triggeredBy !== this.user.id) {
          for (const listener of this.trackListeners) {
            listener(msg.audioTrack, msg.subtitleTrack, msg.triggeredBy, msg.username);
          }
        }
        this.notifyState();
        break;
      }

      case 'members:update': {
        if (!this.roomState) return;
        this.roomState.members = msg.members;
        this.roomState.hostId = msg.hostId;
        this.notifyState();
        break;
      }

      case 'room:bans_update': {
        if (this.roomState) {
          this.roomState.bannedMembers = msg.bannedMembers;
        }
        this.notifyState();
        break;
      }

      case 'chat:message': {
        // Evita duplicatas consecutivas de mensagens do sistema
        const lastMsg = this.chatHistory[this.chatHistory.length - 1];
        if (
          msg.message.isSystem &&
          lastMsg &&
          lastMsg.isSystem &&
          lastMsg.text === msg.message.text &&
          Math.abs(msg.message.timestamp - lastMsg.timestamp) < 4000
        ) {
          break;
        }

        // De-duplicação por ID
        if (this.chatHistory.some((m) => m.id === msg.message.id)) {
          break;
        }

        this.chatHistory.push(msg.message);

        if (this.chatHistory.length > 100) this.chatHistory.shift();
        for (const listener of this.chatListeners) {
          listener(msg.message);
        }
        break;
      }

      case 'server:heartbeat_ack': {
        // Latência calculada no servidor
        break;
      }

      case 'playback:timeline': {
        if (!this.roomState || this.isRoomHost()) return;
        this.roomState.playback.position = msg.position;
        if (msg.rate !== undefined) {
          this.roomState.playback.rate = msg.rate;
        }
        this.roomState.playback.updatedAt = msg.updatedAt || Date.now();
        break;
      }

      case 'error': {
        const errCode = (msg as any).code;
        logger.warn(`[Sala] Servidor: ${msg.message}`);
        if (errCode === 'kicked' || errCode === 'banned') {
          this.leaveRoom();
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.reconnectAttempts = 999;
        }
        for (const listener of this.errorListeners) {
          listener(msg.message, errCode);
        }
        break;
      }
    }
  }

  // --- Comandos de Controle (Host) ---

  public emitPlay(position: number) {
    if (this.isApplyingRemoteUpdate) return;
    this.send({
      type: 'playback:play',
      position: Math.max(0, position),
    });
  }

  public emitPause(position: number) {
    if (this.isApplyingRemoteUpdate) return;
    this.send({
      type: 'playback:pause',
      position: Math.max(0, position),
    });
  }

  public emitSeek(position: number) {
    if (this.isApplyingRemoteUpdate) return;
    this.send({
      type: 'playback:seek',
      position: Math.max(0, position),
    });
  }

  public emitRate(rate: number) {
    if (this.isApplyingRemoteUpdate) return;
    this.send({
      type: 'playback:rate',
      rate,
    });
  }

  public emitMedia(
    media: {
      url: string;
      title: string;
      duration: number;
      parsedTorrent?: any;
      chapters?: any[];
      subtitles?: any[];
      audioTracks?: any[];
    },
    initialPosition: number = 0
  ) {
    if (this.isApplyingRemoteUpdate) return;
    this.send({
      type: 'media:set',
      media,
      initialPosition,
    });
  }

  public emitAudioTrack(trackId: string) {
    if (this.isApplyingRemoteUpdate) return;
    this.send({
      type: 'track:audio',
      trackId,
    });
  }

  public emitSubtitleTrack(trackId: string) {
    if (this.isApplyingRemoteUpdate) return;
    this.send({
      type: 'track:subtitle',
      trackId,
    });
  }

  public emitReadiness(ready: boolean, state: MemberPlaybackState, currentTime: number) {
    this.send({
      type: 'client:readiness',
      ready,
      state,
      currentTime,
    });
  }

  public emitTransferHost(newHostId: string) {
    this.send({
      type: 'room:transfer_host',
      newHostId,
    });
  }

  public emitHostTimeline(position: number, rate?: number) {
    if (!this.isConnected || !this.isRoomHost()) return;
    this.send({
      type: 'playback:timeline',
      position: Math.max(0, position),
      rate,
    });
  }

  public emitKick(targetUserId: string) {
    if (!this.isConnected || !this.isRoomHost()) return;
    this.send({
      type: 'room:kick',
      targetUserId,
    });
  }

  public emitBan(targetUserId: string) {
    if (!this.isConnected || !this.isRoomHost()) return;
    this.send({
      type: 'room:ban',
      targetUserId,
    });
  }

  public emitUnban(targetUserId: string) {
    if (!this.isConnected || !this.isRoomHost()) return;
    this.send({
      type: 'room:unban',
      targetUserId,
    });
  }

  public getBannedMembers(): BannedMember[] {
    return this.roomState?.bannedMembers || [];
  }

  public sendChatMessage(text: string) {
    this.send({
      type: 'chat:send',
      text,
    });
  }

  // --- Linha do Tempo e Drift Correction (Seções 42 e 43) ---

  /**
   * Posição esperada pela linha do tempo autoritativa do servidor
   */
  public getExpectedPosition(): number {
    if (!this.roomState) return 0;
    const { position, playing, rate, updatedAt } = this.roomState.playback;
    if (!playing) return Math.max(0, position);

    const elapsed = (Date.now() - updatedAt) / 1000;
    return Math.max(0, position + elapsed * rate);
  }

  /**
   * Avalia a discrepância (drift) do cliente em relação ao Host
   * Regras rigorosas de sincronização da sala:
   *  - O espectador NUNCA deve correr na frente do Host (tolerância máx 0.5s).
   *  - Se drift > 0.5s (adiantado): seek corretivo imediato para a posição exata do Host.
   *  - Se 0.12s < drift <= 0.5s (levemente adiantado): desacelera (slowdown 0.85x) até o Host alcançar.
   *  - Se drift < -1.2s (muito atrasado): seek corretivo para a posição calculada.
   *  - Se -1.2s <= drift < -0.25s (atrasado): micro-aceleração (speedup 1.08x).
   *  - Se -0.25s <= drift <= 0.12s: sincronia perfeita, reprodução normal (1.0x).
   */
  public calculateDrift(localCurrentTime: number): DriftCorrectionResult {
    if (!this.roomState || this.isRoomHost()) {
      return { drift: 0, action: 'none', targetTime: localCurrentTime };
    }

    const expected = this.getExpectedPosition();
    const drift = localCurrentTime - expected;

    // Se o espectador estiver adiantado em relação ao Host (drift positivo)
    if (drift > 0.5) {
      return {
        drift,
        action: 'seek',
        targetTime: expected,
      };
    }

    if (drift > 0.12) {
      // Espectador adiantado: desacelera para esperar o Host
      return {
        drift,
        action: 'rate_slowdown',
        targetTime: expected,
      };
    }

    // Se o espectador estiver atrasado em relação ao Host (drift negativo)
    if (drift < -1.2) {
      return {
        drift,
        action: 'seek',
        targetTime: expected,
      };
    }

    if (drift < -0.25) {
      // Espectador atrasado: acelera suavemente
      return {
        drift,
        action: 'rate_speedup',
        targetTime: expected,
      };
    }

    return {
      drift,
      action: 'none',
      targetTime: expected,
    };
  }

  // --- Inscrições de Eventos ---

  public subscribeState(listener: SyncStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.roomState);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public subscribePlayback(listener: PlaybackSyncListener): () => void {
    this.playbackListeners.add(listener);
    return () => {
      this.playbackListeners.delete(listener);
    };
  }

  public subscribeMedia(listener: MediaSyncListener): () => void {
    this.mediaListeners.add(listener);
    return () => {
      this.mediaListeners.delete(listener);
    };
  }

  public subscribeTracks(listener: TrackSyncListener): () => void {
    this.trackListeners.add(listener);
    return () => {
      this.trackListeners.delete(listener);
    };
  }

  public subscribeChat(listener: ChatListener): () => void {
    this.chatListeners.add(listener);
    return () => {
      this.chatListeners.delete(listener);
    };
  }

  public subscribeError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  private notifyState() {
    for (const listener of this.stateListeners) {
      listener(this.roomState);
    }
  }
}

export const syncManager = new SyncManager();

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
