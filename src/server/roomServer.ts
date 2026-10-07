import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { issueRoomToken } from './access';
import { isOriginAllowed } from './cors';
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

interface ClientSession {
  ws: WebSocket;
  roomId: string;
  userId: string;
  username: string;
  avatarUrl?: string;
  platform?: 'discord' | 'web';
  isHost: boolean;
  ready: boolean;
  state: MemberPlaybackState;
  currentTime: number;
  lastPing: number;
}

interface RoomInternal {
  roomId: string;
  hostId: string;
  media: RoomMedia | null;
  playback: {
    playing: boolean;
    position: number;
    rate: number;
    updatedAt: number;
  };
  clients: Map<WebSocket, ClientSession>;
  chatHistory: ChatMessage[];
  cleanupTimer?: NodeJS.Timeout;
  pendingLeaves: Map<string, { timer: NodeJS.Timeout; session: ClientSession }>;
  announcedJoins: Set<string>;
  bannedMembers: Map<string, BannedMember>;
}

/** Quanto tempo uma sala sem ninguém continua existindo (dá tempo de recarregar a página e voltar). */
const EMPTY_ROOM_TTL_MS = 30 * 1000;

export class RoomManager {
  private rooms = new Map<string, RoomInternal>();
  // Salas removidas por inatividade (para a Home distinguir "encerrada" de "código errado")
  private closedRooms = new Map<string, number>();

  public getRoomInfo(roomId: string): { exists: boolean; closed: boolean; members: number; hasMedia: boolean } {
    const room = this.rooms.get(roomId);
    if (room) {
      return { exists: true, closed: false, members: room.clients.size, hasMedia: Boolean(room.media) };
    }
    return { exists: false, closed: this.closedRooms.has(roomId), members: 0, hasMedia: false };
  }

  /** A pessoa está (ou acabou de cair e pode voltar) na sala, e não foi banida? */
  public isMember(roomId: string, userId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.bannedMembers.has(userId)) return false;
    if (room.pendingLeaves.has(userId)) return true;
    for (const s of room.clients.values()) if (s.userId === userId) return true;
    return false;
  }

  /** Host de uma sala ativa, com conexão aberta agora. */
  public isHostMember(roomId: string, userId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.hostId !== userId) return false;
    for (const s of room.clients.values()) if (s.userId === userId) return true;
    return false;
  }

  public isRoomActive(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  /** Quando a sala foi encerrada (ms), ou `undefined` se ainda existe / o servidor não sabe. */
  public getClosedAt(roomId: string): number | undefined {
    return this.closedRooms.get(roomId);
  }

  private calculateCurrentPosition(playback: RoomInternal['playback']): number {
    if (!playback.playing) {
      return Math.max(0, playback.position);
    }
    const elapsed = (Date.now() - playback.updatedAt) / 1000;
    return Math.max(0, playback.position + elapsed * playback.rate);
  }

  public getOrCreateRoom(roomId: string, initialHostId?: string): RoomInternal {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        roomId,
        hostId: initialHostId || '',
        media: null,
        playback: {
          playing: false,
          position: 0,
          rate: 1.0,
          updatedAt: Date.now(),
        },
        clients: new Map(),
        chatHistory: [],
        pendingLeaves: new Map(),
        announcedJoins: new Set(),
        bannedMembers: new Map(),
      };
      this.rooms.set(roomId, room);
      this.closedRooms.delete(roomId);
      console.log(`[WatchParty] 🏠 Nova sala criada: "${roomId}"`);
    } else if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = undefined;
    }
    return room;
  }

  public getRoomState(room: RoomInternal): RoomState {
    const currentPos = this.calculateCurrentPosition(room.playback);
    const uniqueClientsMap = new Map<string, ClientSession>();
    for (const session of room.clients.values()) {
      uniqueClientsMap.set(session.userId, session);
    }
    const members: RoomMember[] = Array.from(uniqueClientsMap.values()).map((c) => ({
      id: c.userId,
      username: c.username,
      avatarUrl: c.avatarUrl,
      platform: c.platform || 'web',
      isHost: c.userId === room.hostId,
      ready: c.ready,
      state: c.state,
      currentTime: c.currentTime,
      ping: c.lastPing,
    }));

    return {
      roomId: room.roomId,
      hostId: room.hostId,
      media: room.media,
      playback: {
        playing: room.playback.playing,
        position: currentPos,
        rate: room.playback.rate,
        updatedAt: Date.now(),
      },
      members,
      bannedMembers: Array.from(room.bannedMembers ? room.bannedMembers.values() : []),
    };
  }

  public broadcast(room: RoomInternal, message: ServerMessage, excludeWs?: WebSocket) {
    const payload = JSON.stringify(message);
    for (const [ws] of room.clients) {
      if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch (err) {
          console.warn('[WatchParty] Erro ao enviar mensagem para socket:', err);
        }
      }
    }
  }

  public sendSystemChat(room: RoomInternal, text: string, excludeWs?: WebSocket) {
    const chatMsg: ChatMessage = {
      id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      userId: 'system',
      username: 'Sistema',
      text,
      timestamp: Date.now(),
      isSystem: true,
    };

    // Transmite notificação ao vivo para os membros conectados (estilo juntos.lol),
    // sem poluir o histórico persistente de mensagens de conversa
    this.broadcast(room, {
      type: 'chat:message',
      message: chatMsg,
    }, excludeWs);
  }

  public handleJoin(
    ws: WebSocket,
    roomId: string,
    user: { id: string; username: string; avatarUrl?: string; platform?: 'discord' | 'web' }
  ) {
    const room = this.getOrCreateRoom(roomId, user.id);

    if (room.bannedMembers && room.bannedMembers.has(user.id)) {
      console.log(`[WatchParty] ⛔ Usuário banido "${user.username}" (${user.id}) tentou entrar na sala "${roomId}".`);
      this.send(ws, { type: 'error', message: 'Você foi banido desta sala pelo Host.', code: 'banned' });
      try {
        ws.close(4002, 'Banned by host');
      } catch {}
      return;
    }

    // Se a sala estava sem host ou com host inválido, atribui ao novo usuário
    if (!room.hostId || !Array.from(room.clients.values()).some((c) => c.userId === room.hostId)) {
      room.hostId = user.id;
    }

    const session: ClientSession = {
      ws,
      roomId,
      userId: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      platform: user.platform || 'web',
      isHost: room.hostId === user.id,
      ready: false,
      state: 'waiting',
      currentTime: 0,
      lastPing: 0,
    };

    // Se havia uma desconexão pendente com grace period deste usuário, cancela
    const pendingLeave = room.pendingLeaves.get(user.id);
    let wasPending = false;
    if (pendingLeave) {
      clearTimeout(pendingLeave.timer);
      room.pendingLeaves.delete(user.id);
      wasPending = true;
    }

    // Verifica se já existe conexão com este mesmo userId
    let isReconnecting = wasPending;
    for (const [oldWs, s] of Array.from(room.clients.entries())) {
      if (s.userId === user.id) {
        if (oldWs !== ws && oldWs.readyState === WebSocket.OPEN) {
          // Conexão concorrente detectada (ex: duas abas abertas no mesmo navegador ou sessão duplicada):
          // Atribui um ID único para esta nova conexão para que NUNCA desconecte ou substitua a outra aba!
          const suffix = Math.floor(1000 + Math.random() * 9000);
          session.userId = `${user.id}_tab${suffix}`;
          user.id = session.userId;
          session.isHost = false; // Segunda conexão nunca rouba a liderança da primeira
          isReconnecting = false;
          console.log(`[WatchParty] 🔀 Conexão concorrente na sala "${roomId}". Novo ID atribuído: "${session.userId}" para "${user.username}".`);
        } else if (oldWs !== ws) {
          // O socket anterior caiu ou fechou: limpa e assume reconexão
          isReconnecting = true;
          room.clients.delete(oldWs);
        }
      }
    }

    room.clients.set(ws, session);

    console.log(
      `[WatchParty] 👤 "${user.username}" (${session.userId}) ${isReconnecting ? 'reconectou silenciosamente' : 'entrou'} na sala "${roomId}". Membros: ${room.clients.size}`
    );

    // Envia estado completo atualizado para quem acabou de entrar (Late join)
    const currentState = this.getRoomState(room);
    this.send(ws, {
      type: 'room:state',
      state: currentState,
      assignedUserId: session.userId,
      accessToken: issueRoomToken(roomId, session.userId),
    });

    // Envia histórico de chat recente para o novo membro
    for (const msg of room.chatHistory.slice(-20)) {
      this.send(ws, {
        type: 'chat:message',
        message: msg,
      });
    }

    // Envia confirmação de entrada para o próprio membro que acabou de entrar
    this.send(ws, {
      type: 'chat:message',
      message: {
        id: `sys_join_${Date.now()}_${user.id}`,
        userId: 'system',
        username: 'Sistema',
        text: `Você entrou na sala "${roomId}".`,
        timestamp: Date.now(),
        isSystem: true,
      },
    });

    // Só notifica os demais membros uma ÚNICA vez por usuário e se houver outros membros
    const joinKey = `${user.id}_${user.username}`;
    if (!room.announcedJoins.has(joinKey) && !room.announcedJoins.has(user.id)) {
      room.announcedJoins.add(joinKey);
      room.announcedJoins.add(user.id);
      if (room.clients.size > 1 && !isReconnecting) {
        this.sendSystemChat(room, `${user.username} entrou na sala.`, ws);
      }
    }
    this.broadcastMembersUpdate(room);
  }

  public handleLeave(ws: WebSocket) {
    for (const [roomId, room] of this.rooms.entries()) {
      const session = room.clients.get(ws);
      if (session) {
        room.clients.delete(ws);
        console.log(`[WatchParty] 🔌 Socket de "${session.username}" desconectado na sala "${roomId}". Restam ativos: ${room.clients.size}`);

        const hasRemainingConnection = Array.from(room.clients.values()).some((s) => s.userId === session.userId);
        if (!hasRemainingConnection) {
          // Grace period de 4 segundos: evita spam de "saiu" e "entrou" no StrictMode, refresh de página ou HMR
          if (room.pendingLeaves.has(session.userId)) {
            clearTimeout(room.pendingLeaves.get(session.userId)!.timer);
          }

          const leaveTimer = setTimeout(() => {
            room.pendingLeaves.delete(session.userId);
            const isBack = Array.from(room.clients.values()).some((s) => s.userId === session.userId);
            if (!isBack) {
              room.announcedJoins.delete(session.userId);
              console.log(`[WatchParty] 🚪 "${session.username}" saiu definitivamente da sala "${roomId}".`);
              if (room.clients.size > 0) {
                this.sendSystemChat(room, `${session.username} saiu da sala.`);
              }

              // Se o Host saiu definitivamente, elege o próximo participante ativo como novo Host
              if (room.hostId === session.userId && room.clients.size > 0) {
                const nextClient = room.clients.values().next().value;
                if (nextClient) {
                  room.hostId = nextClient.userId;
                  nextClient.isHost = true;
                  console.log(`[WatchParty] 👑 Novo Host eleito para sala "${roomId}": "${nextClient.username}"`);
                  this.sendSystemChat(room, `👑 ${nextClient.username} é o novo Host da sala.`);
                }
              }

              this.broadcastMembersUpdate(room);

              // Sala vazia: encerra após EMPTY_ROOM_TTL_MS (cancelado se alguém reentrar antes)
              if (room.clients.size === 0 && room.pendingLeaves.size === 0) {
                room.cleanupTimer = setTimeout(() => {
                  this.rooms.delete(roomId);
                  this.closedRooms.set(roomId, Date.now());
                  console.log(`[WatchParty] 🧹 Sala vazia "${roomId}" encerrada após ${EMPTY_ROOM_TTL_MS / 1000}s sem ninguém.`);
                }, EMPTY_ROOM_TTL_MS);
              }
            }
          }, 4000);

          room.pendingLeaves.set(session.userId, { timer: leaveTimer, session });
        }
        break;
      }
    }
  }

  public broadcastMembersUpdate(room: RoomInternal) {
    const uniqueClientsMap = new Map<string, ClientSession>();
    for (const session of room.clients.values()) {
      uniqueClientsMap.set(session.userId, session);
    }
    const members: RoomMember[] = Array.from(uniqueClientsMap.values()).map((c) => ({
      id: c.userId,
      username: c.username,
      avatarUrl: c.avatarUrl,
      platform: c.platform || 'web',
      isHost: c.userId === room.hostId,
      ready: c.ready,
      state: c.state,
      currentTime: c.currentTime,
      ping: c.lastPing,
    }));

    this.broadcast(room, {
      type: 'members:update',
      members,
      hostId: room.hostId,
    });
  }

  public send(ws: WebSocket, message: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (e) {
        console.warn('[WatchParty] Falha ao enviar mensagem:', e);
      }
    }
  }

  public handleClientMessage(ws: WebSocket, raw: string) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'room:join') {
      const user = msg.user;
      if (
        typeof msg.roomId !== 'string' ||
        !/^[\w-]{1,64}$/.test(msg.roomId) ||
        !user ||
        typeof user.id !== 'string' ||
        user.id.length === 0 ||
        user.id.length > 96 ||
        typeof user.username !== 'string'
      ) {
        this.send(ws, { type: 'error', message: 'Dados de entrada inválidos.', code: 'bad_request' });
        return;
      }
      this.handleJoin(ws, msg.roomId, { ...user, username: user.username.trim().slice(0, 32) || 'Espectador' });
      return;
    }

    // Localiza a sessão do cliente
    let clientSession: ClientSession | undefined;
    let currentRoom: RoomInternal | undefined;
    for (const room of this.rooms.values()) {
      if (room.clients.has(ws)) {
        currentRoom = room;
        clientSession = room.clients.get(ws);
        break;
      }
    }

    if (!currentRoom || !clientSession) {
      this.send(ws, { type: 'error', message: 'Você não está conectado a nenhuma sala ativa.' });
      return;
    }

    const isHost = currentRoom.hostId === clientSession.userId;

    switch (msg.type) {
      case 'room:leave': {
        this.handleLeave(ws);
        break;
      }

      case 'playback:play': {
        if (!isHost) {
          console.warn(`[WatchParty] Usuário não-host tentou dar play: ${clientSession.username}`);
          return;
        }
        currentRoom.playback = {
          playing: true,
          position: Math.max(0, msg.position),
          rate: currentRoom.playback.rate,
          updatedAt: Date.now(),
        };

        this.broadcast(currentRoom, {
          type: 'playback:sync',
          playback: currentRoom.playback,
          action: 'play',
          triggeredBy: clientSession.userId,
          username: clientSession.username,
        });
        break;
      }

      case 'playback:pause': {
        if (!isHost) return;
        currentRoom.playback = {
          playing: false,
          position: Math.max(0, msg.position),
          rate: currentRoom.playback.rate,
          updatedAt: Date.now(),
        };

        this.broadcast(currentRoom, {
          type: 'playback:sync',
          playback: currentRoom.playback,
          action: 'pause',
          triggeredBy: clientSession.userId,
          username: clientSession.username,
        });
        break;
      }

      case 'playback:seek': {
        if (!isHost) return;
        currentRoom.playback = {
          playing: currentRoom.playback.playing,
          position: Math.max(0, msg.position),
          rate: currentRoom.playback.rate,
          updatedAt: Date.now(),
        };

        this.broadcast(currentRoom, {
          type: 'playback:sync',
          playback: currentRoom.playback,
          action: 'seek',
          triggeredBy: clientSession.userId,
          username: clientSession.username,
        });
        break;
      }

      case 'playback:rate': {
        if (!isHost) return;
        const currentPos = this.calculateCurrentPosition(currentRoom.playback);
        currentRoom.playback = {
          playing: currentRoom.playback.playing,
          position: currentPos,
          rate: Math.max(0.25, Math.min(3.0, msg.rate)),
          updatedAt: Date.now(),
        };

        this.broadcast(currentRoom, {
          type: 'playback:sync',
          playback: currentRoom.playback,
          action: 'rate',
          triggeredBy: clientSession.userId,
          username: clientSession.username,
        });
        break;
      }

      case 'media:set': {
        if (!isHost) return;
        const newGeneration = (currentRoom.media?.generation || 0) + 1;
        currentRoom.media = {
          generation: newGeneration,
          url: msg.media.url,
          title: msg.media.title,
          duration: msg.media.duration,
          parsedTorrent: msg.media.parsedTorrent,
          chapters: msg.media.chapters,
          subtitles: msg.media.subtitles,
          audioTracks: msg.media.audioTracks,
        };

        currentRoom.playback = {
          playing: false,
          position: msg.initialPosition || 0,
          rate: 1.0,
          updatedAt: Date.now(),
        };

        console.log(`[WatchParty] 🎬 Nova mídia definida na sala "${currentRoom.roomId}": "${msg.media.title}"`);
        this.sendSystemChat(currentRoom, `🎬 ${clientSession.username} carregou: "${msg.media.title || 'Novo Vídeo'}"`);

        this.broadcast(currentRoom, {
          type: 'media:sync',
          media: currentRoom.media,
          generation: newGeneration,
          triggeredBy: clientSession.userId,
          username: clientSession.username,
        });

        this.broadcast(currentRoom, {
          type: 'room:state',
          state: this.getRoomState(currentRoom),
        });
        break;
      }

      case 'playback:timeline': {
        if (!isHost) return;
        const now = Date.now();
        currentRoom.playback = {
          playing: currentRoom.playback.playing,
          position: Math.max(0, msg.position),
          rate: msg.rate !== undefined ? Math.max(0.25, Math.min(3.0, msg.rate)) : currentRoom.playback.rate,
          updatedAt: now,
        };

        // Transmite a timeline autoritativa do Host para todos os espectadores na sala
        this.broadcast(
          currentRoom,
          {
            type: 'playback:timeline',
            position: currentRoom.playback.position,
            rate: currentRoom.playback.rate,
            updatedAt: now,
          },
          ws
        );
        break;
      }

      case 'client:readiness': {
        clientSession.ready = msg.ready;
        clientSession.state = msg.state;
        clientSession.currentTime = msg.currentTime;
        this.broadcastMembersUpdate(currentRoom);
        break;
      }

      case 'client:heartbeat': {
        const now = Date.now();
        clientSession.lastPing = Math.max(0, now - msg.clientTime);
        clientSession.currentTime = msg.currentTime;
        clientSession.state = msg.state;

        this.send(ws, {
          type: 'server:heartbeat_ack',
          clientTime: msg.clientTime,
          serverTime: now,
        });
        break;
      }

      case 'room:transfer_host': {
        if (!isHost) return;
        const targetMember = Array.from(currentRoom.clients.values()).find((c) => c.userId === msg.newHostId);
        if (targetMember) {
          currentRoom.hostId = targetMember.userId;
          console.log(`[WatchParty] 👑 Controle transferido para "${targetMember.username}"`);
          this.sendSystemChat(currentRoom, `👑 ${clientSession.username} transferiu o controle para ${targetMember.username}.`);
          this.broadcastMembersUpdate(currentRoom);
        }
        break;
      }

      case 'room:kick': {
        if (!isHost) return;
        const targetUserId = msg.targetUserId;
        if (targetUserId === clientSession.userId) return; // Não pode expulsar a si mesmo

        for (const [targetWs, targetSession] of Array.from(currentRoom.clients.entries())) {
          if (targetSession.userId === targetUserId) {
            console.log(`[WatchParty] 👢 "${clientSession.username}" expulsou "${targetSession.username}" (${targetUserId}) da sala "${currentRoom.roomId}".`);
            this.send(targetWs, {
              type: 'error',
              message: 'Você foi expulso da sala pelo Host.',
              code: 'kicked',
            });
            this.sendSystemChat(currentRoom, `👢 ${targetSession.username} foi expulso da sala.`);
            try {
              targetWs.close(4001, 'Kicked by host');
            } catch {}
            this.handleLeave(targetWs);
          }
        }
        break;
      }

      case 'room:ban': {
        if (!isHost) return;
        const targetUserId = msg.targetUserId;
        if (targetUserId === clientSession.userId) return;

        let bannedName = 'Usuário';
        let bannedAvatar: string | undefined;
        let bannedPlatform: 'discord' | 'web' = 'web';

        for (const [targetWs, targetSession] of Array.from(currentRoom.clients.entries())) {
          if (targetSession.userId === targetUserId) {
            bannedName = targetSession.username;
            bannedAvatar = targetSession.avatarUrl;
            bannedPlatform = targetSession.platform || 'web';
            console.log(`[WatchParty] 🔨 "${clientSession.username}" baniu "${targetSession.username}" (${targetUserId}) da sala "${currentRoom.roomId}".`);
            this.send(targetWs, {
              type: 'error',
              message: 'Você foi banido desta sala pelo Host.',
              code: 'banned',
            });
            this.sendSystemChat(currentRoom, `🔨 ${targetSession.username} foi banido permanentemente da sala.`);
            try {
              targetWs.close(4002, 'Banned by host');
            } catch {}
            this.handleLeave(targetWs);
          }
        }

        if (!currentRoom.bannedMembers) {
          currentRoom.bannedMembers = new Map();
        }
        currentRoom.bannedMembers.set(targetUserId, {
          userId: targetUserId,
          username: bannedName,
          avatarUrl: bannedAvatar,
          platform: bannedPlatform,
          bannedAt: Date.now(),
        });

        this.broadcast(currentRoom, {
          type: 'room:bans_update',
          bannedMembers: Array.from(currentRoom.bannedMembers.values()),
        });
        this.broadcast(currentRoom, {
          type: 'room:state',
          state: this.getRoomState(currentRoom),
        });
        break;
      }

      case 'room:unban': {
        if (!isHost) return;
        const targetUserId = msg.targetUserId;
        if (currentRoom.bannedMembers && currentRoom.bannedMembers.has(targetUserId)) {
          const unbanned = currentRoom.bannedMembers.get(targetUserId);
          currentRoom.bannedMembers.delete(targetUserId);
          console.log(`[WatchParty] 🕊️ "${clientSession.username}" desbaniu "${unbanned?.username || targetUserId}" da sala "${currentRoom.roomId}".`);
          this.sendSystemChat(currentRoom, `🕊️ ${unbanned?.username || 'Usuário'} foi desbanido da sala.`);
          this.broadcast(currentRoom, {
            type: 'room:bans_update',
            bannedMembers: Array.from(currentRoom.bannedMembers.values()),
          });
          this.broadcast(currentRoom, {
            type: 'room:state',
            state: this.getRoomState(currentRoom),
          });
        }
        break;
      }

      case 'user:update': {
        const oldName = clientSession.username;
        const newName = (msg.username || '').trim().slice(0, 32);
        if (newName && newName !== oldName) {
          clientSession.username = newName;
          if (msg.avatarUrl !== undefined) clientSession.avatarUrl = msg.avatarUrl;
          console.log(`[WatchParty] ✏️ "${oldName}" alterou nome para "${newName}" na sala "${currentRoom.roomId}"`);
          // Anuncia no chat para todos, inclusive quem trocou (também "Espectador #1234" → nome real)
          this.sendSystemChat(currentRoom, `${oldName} agora se chama ${newName}.`);
          this.broadcastMembersUpdate(currentRoom);
        }
        break;
      }

      case 'chat:send': {
        const text = (msg.text || '').trim();
        if (!text) return;

        const chatMsg: ChatMessage = {
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId: clientSession.userId,
          username: clientSession.username,
          avatarUrl: clientSession.avatarUrl,
          text,
          timestamp: Date.now(),
        };

        currentRoom.chatHistory.push(chatMsg);
        if (currentRoom.chatHistory.length > 100) currentRoom.chatHistory.shift();

        this.broadcast(currentRoom, {
          type: 'chat:message',
          message: chatMsg,
        });
        break;
      }
    }
  }
}

export const roomManager = new RoomManager();

/**
 * Registra o servidor WebSocket no servidor HTTP/HTTPS existente do Vite
 */
export function setupWebSocketServer(httpServer: any) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = req.url || '';
    // Suporte às rotas diretas e com prefixo proxy do Discord
    const isWatchPartyWs =
      url.startsWith('/api/ws') ||
      url.startsWith('/ws') ||
      url.startsWith('/.proxy/api/ws') ||
      url.startsWith('/.proxy/ws');

    if (isWatchPartyWs) {
      // Origem de outro site não abre WebSocket (evita que uma página qualquer controle a sala do visitante)
      if (!isOriginAllowed(req.headers.origin, req.headers)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    console.log('[WatchParty] 🔌 Nova conexão WebSocket estabelecida de:', req.url);

    ws.on('message', (data) => {
      roomManager.handleClientMessage(ws, data.toString());
    });

    ws.on('close', () => {
      roomManager.handleLeave(ws);
    });

    ws.on('error', (err) => {
      console.warn('[WatchParty] Erro de WebSocket:', err);
      roomManager.handleLeave(ws);
    });
  });

  console.log('[WatchParty] ✅ Servidor WebSocket integrado com sucesso em /api/ws e /.proxy/api/ws');
  return wss;
}
