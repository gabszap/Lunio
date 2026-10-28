import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { issueRoomToken } from './access';
import { config } from './config';
import { isOriginAllowed } from './cors';
import { PLAYLIST_MAX_ITEMS, playlistUrlKey } from '../types/sync';
import { warmUpMedia } from './media/resolver';
import { pruneRoomUploads, uploadIdFromUrl } from './media/uploads';
import { uploadIndex } from './media/uploadIndex';
import { roomStore, type PersistedRoom, type RoomStore } from './roomStore';
import { isLinkId, linksOf, resolveLinkId, scrubFor, type LinkEntry } from './links';
import type {
  ClientMessage,
  ServerMessage,
  SkipVoteState,
  RoomState,
  RoomMember,
  RoomMedia,
  ChatMessage,
  MemberPlaybackState,
  BannedMember,
  PlaylistItem,
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
  playlist: PlaylistItem[];
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
  /**
   * Sala restaurada do Redis depois de um restart: até este instante só o Host antigo pode reassumir o controle
   * (quem reconectar primeiro entra como espectador). Passado o prazo, vale a regra de sempre.
   */
  hostGraceUntil?: number;
  hostGraceTimer?: NodeJS.Timeout;
  /** Votação para pular o capítulo atual (só na memória: some com a troca de vídeo ou do ponto do vídeo). */
  skipVote?: { start: number; target: number; voters: Set<string>; lastBroadcast: string };
  /** Itens que o Host acabou de tirar da fila para tocar: o `media:set` que vem logo depois ainda chega com o id deles. */
  takenLinks: Array<LinkEntry & { at: number }>;
}

/** O servidor dá `<id>_tab####` à segunda aba aberta pela mesma pessoa; o ban vale para o ID de verdade (todas as abas). */
export const baseUserId = (id: string) => id.replace(/_tab\d{4}$/, '');

/** Quanto tempo uma sala sem ninguém continua existindo (dá tempo de recarregar a página e voltar). */
const EMPTY_ROOM_TTL_MS = 30 * 1000;

/** Mensagens que mudam o que o Redis guarda (Host, banidos, fila, vídeo e posição). */
const PERSISTED_MESSAGES = new Set<string>([
  'playlist:add', 'playlist:remove', 'playlist:move', 'playlist:take', 'media:set',
  'room:transfer_host', 'room:ban', 'room:unban',
  'playback:play', 'playback:pause', 'playback:seek', 'playback:rate', 'playback:timeline',
]);
/** O Host manda a posição a cada poucos segundos: gravar no máximo a cada 5 s por sala. */
const TIMELINE_PERSIST_GAP_MS = 5000;
/** Servidor parado por mais que isto: a sala volta pausada (não finge que o vídeo andou o tempo todo). */
const RESTORE_MAX_PLAYING_GAP_MS = 120_000;

/** Quanto tempo o item tirado da fila ainda pode ser tocado pelo id (o `playlist:take` e o `media:set` saem juntos). */
const TAKEN_LINK_TTL_MS = 2 * 60_000;
/** Identidade do vídeo que pode ir aos outros: só as que não carregam o link (`ih:`/`vh:`). */
const FINGERPRINT_RE = /^(ih|vh):[\w:|.\- ]{1,300}$/i;

export class RoomManager {
  private rooms = new Map<string, RoomInternal>();
  private sessions = new WeakMap<WebSocket, ClientSession>();
  // Salas removidas por inatividade (para a Home distinguir "encerrada" de "código errado")
  private closedRooms = new Map<string, number>();
  private persistTimers = new Map<string, NodeJS.Timeout>();
  private lastPersisted = new Map<string, number>();
  private pendingSaves = new Set<Promise<void>>();

  constructor(private readonly store: RoomStore = roomStore) {}

  public getRoomInfo(roomId: string): { exists: boolean; closed: boolean; members: number; hasMedia: boolean } {
    const room = this.rooms.get(roomId);
    if (room) {
      return { exists: true, closed: false, members: room.clients.size, hasMedia: Boolean(room.media) };
    }
    return { exists: false, closed: this.closedRooms.has(roomId), members: 0, hasMedia: false };
  }

  /** Salas com gente conectada e quantas pessoas (cada pessoa conta uma vez, mesmo com várias abas). */
  public getStats(): { rooms: number; people: number } {
    let rooms = 0;
    const people = new Set<string>();
    for (const room of this.rooms.values()) {
      if (room.clients.size === 0) continue;
      rooms++;
      for (const c of room.clients.values()) people.add(baseUserId(c.userId));
    }
    return { rooms, people: people.size };
  }

  /** Ids dos envios que a sala usa agora: a mídia atual e os itens da fila. */
  public referencedUploadIds(roomId: string): Set<string> {
    const ids = new Set<string>();
    const room = this.rooms.get(roomId);
    if (!room) return ids;
    for (const url of [room.media?.url, ...room.playlist.map((i) => i.url)]) {
      const id = url ? uploadIdFromUrl(url) : null;
      if (id) ids.add(id);
    }
    return ids;
  }

  /** A pessoa está (ou acabou de cair e pode voltar) na sala, e não foi banida? */
  public isMember(roomId: string, userId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.bannedMembers.has(baseUserId(userId))) return false;
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
        playlist: [],
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
        takenLinks: [],
        bannedMembers: new Map(),
      };
      this.rooms.set(roomId, room);
      this.closedRooms.delete(roomId);
      uploadIndex.reopenRoom(roomId); // a sala voltou: o envio dela volta a "não fechada"
      console.log(`[WatchParty] 🏠 Nova sala criada: "${roomId}"`);
      this.schedulePersist(room);
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
      playlist: room.playlist,
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
    // Cada pessoa vê inteiro só o link que ela mesma enviou; o dos outros vai como id opaco
    const links = payload.includes('http') ? this.linksFor(room) : [];
    for (const [ws, session] of room.clients) {
      if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(links.length ? scrubFor(links, session.userId, payload) : payload);
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

    if (room.bannedMembers && room.bannedMembers.has(baseUserId(user.id))) {
      console.log(`[WatchParty] ⛔ Usuário banido "${user.username}" (${user.id}) tentou entrar na sala "${roomId}".`);
      this.send(ws, { type: 'error', message: 'Você foi banido desta sala pelo Host.', code: 'banned' });
      try {
        ws.close(4002, 'Banned by host');
      } catch {}
      return;
    }

    // Se a sala estava sem host ou com host inválido, atribui ao novo usuário
    const hostBefore = room.hostId;
    const hostConnected = Array.from(room.clients.values()).some((c) => c.userId === room.hostId);
    if (room.hostId && user.id === room.hostId) {
      // O Host antigo voltou (restart do servidor): a janela de prioridade acabou
      if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = undefined;
      room.hostGraceUntil = undefined;
    } else if (!room.hostId || (!hostConnected && !(room.hostGraceUntil !== undefined && Date.now() < room.hostGraceUntil))) {
      room.hostId = user.id;
    }
    if (room.hostId !== hostBefore) this.schedulePersist(room);

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
    this.sessions.set(ws, session);

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

    // Votação para pular em andamento: o recém-chegado também a vê
    if (room.skipVote) this.send(ws, { type: 'skip:votes', skip: this.skipVoteState(room) });

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
                  this.schedulePersist(room);
                  console.log(`[WatchParty] 👑 Novo Host eleito para sala "${roomId}": "${nextClient.username}"`);
                  this.sendSystemChat(room, `👑 ${nextClient.username} é o novo Host da sala.`);
                }
              }

              this.broadcastMembersUpdate(room);

              // Sala vazia: encerra após EMPTY_ROOM_TTL_MS (cancelado se alguém reentrar antes)
              if (room.clients.size === 0 && room.pendingLeaves.size === 0) {
                room.cleanupTimer = setTimeout(() => this.closeEmptyRoom(room), EMPTY_ROOM_TTL_MS);
              }
            }
          }, 4000);

          room.pendingLeaves.set(session.userId, { timer: leaveTimer, session });
        }
        break;
      }
    }
  }

  /** Encerra uma sala que ficou sem ninguém: marca o fechamento (o prazo dos envios conta daqui) e apaga o estado do Redis. */
  private closeEmptyRoom(room: RoomInternal) {
    const roomId = room.roomId;
    // Alguém voltou a tempo (ou a sala já foi trocada): não encerra
    if (this.rooms.get(roomId) !== room || room.clients.size > 0 || room.pendingLeaves.size > 0) return;
    if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
    const pending = this.persistTimers.get(roomId);
    if (pending) clearTimeout(pending);
    this.persistTimers.delete(roomId);
    this.lastPersisted.delete(roomId);
    const closedAt = Date.now();
    this.rooms.delete(roomId);
    this.closedRooms.set(roomId, closedAt);
    uploadIndex.closeRoom(roomId, closedAt); // persiste nos metadados: o prazo sobrevive ao restart
    this.track(this.store.remove(roomId)); // sala fechada não guarda nem a fila
    console.log(`[WatchParty] 🧹 Sala vazia "${roomId}" encerrada após ${EMPTY_ROOM_TTL_MS / 1000}s sem ninguém.`);
  }

  /** O Host antigo não voltou dentro da janela: o primeiro conectado assume (a regra de quando o Host sai). */
  private electHostIfMissing(room: RoomInternal) {
    room.hostGraceUntil = undefined;
    room.hostGraceTimer = undefined;
    if (this.rooms.get(room.roomId) !== room || room.clients.size === 0) return;
    if (Array.from(room.clients.values()).some((c) => c.userId === room.hostId)) return;
    const next = room.clients.values().next().value;
    if (!next) return;
    room.hostId = next.userId;
    next.isHost = true;
    console.log(`[WatchParty] 👑 O Host antigo não voltou a tempo; novo Host da sala "${room.roomId}": "${next.username}"`);
    this.sendSystemChat(room, `👑 ${next.username} é o novo Host da sala.`);
    this.broadcastMembersUpdate(room);
    this.schedulePersist(room);
  }

  // ───────────── estado das salas no Redis ─────────────

  private track(save: Promise<void>) {
    this.pendingSaves.add(save);
    void save.finally(() => this.pendingSaves.delete(save));
  }

  /** O que o Redis guarda da sala (a posição é a de agora, com o tempo corrido se estiver tocando). */
  private snapshot(room: RoomInternal): PersistedRoom {
    return {
      v: 1,
      roomId: room.roomId,
      hostId: room.hostId,
      media: room.media,
      playlist: room.playlist,
      bans: Array.from(room.bannedMembers.values()),
      playback: { playing: room.playback.playing, position: this.calculateCurrentPosition(room.playback), rate: room.playback.rate },
      savedAt: Date.now(),
    };
  }

  /** Agenda a gravação (debounce de 250 ms, ou o intervalo pedido): nada aqui espera o Redis. */
  private schedulePersist(room: RoomInternal, minGapMs = 250) {
    if (this.persistTimers.has(room.roomId)) return;
    const wait = Math.max(250, (this.lastPersisted.get(room.roomId) ?? 0) + minGapMs - Date.now());
    const timer = setTimeout(() => {
      this.persistTimers.delete(room.roomId);
      this.persistNow(room.roomId);
    }, wait);
    timer.unref?.();
    this.persistTimers.set(room.roomId, timer);
  }

  private persistNow(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return Promise.resolve();
    this.lastPersisted.set(roomId, Date.now());
    const save = this.store.save(this.snapshot(room));
    this.track(save);
    return save;
  }

  /** No encerramento do servidor: grava o estado mais novo de todas as salas e espera o Redis confirmar. */
  public async flushPersistence(): Promise<void> {
    for (const timer of this.persistTimers.values()) clearTimeout(timer);
    this.persistTimers.clear();
    await Promise.all(Array.from(this.rooms.keys()).map((id) => this.persistNow(id)));
    await Promise.all(Array.from(this.pendingSaves));
  }

  /**
   * Na subida: recria as salas gravadas, sem ninguém conectado. O Host antigo tem `hostGraceMs` de prioridade; sala que
   * ninguém reocupar encerra sozinha depois da janela mais o prazo de sala vazia. Devolve quantas voltaram.
   */
  public async restore(): Promise<number> {
    const { rooms, closed } = await this.store.loadAll();
    for (const c of closed) if (!this.closedRooms.has(c.roomId)) this.closedRooms.set(c.roomId, c.at);

    const now = Date.now();
    let restored = 0;
    for (const p of rooms) {
      const downtime = now - p.savedAt;
      if (this.rooms.has(p.roomId) || downtime > config.roomStateTtlMs) continue;
      const playing = p.playback.playing && downtime < RESTORE_MAX_PLAYING_GAP_MS;
      const room: RoomInternal = {
        roomId: p.roomId,
        hostId: p.hostId,
        media: p.media,
        playlist: p.playlist,
        playback: { playing, position: p.playback.position + (playing ? (downtime / 1000) * p.playback.rate : 0), rate: p.playback.rate, updatedAt: now },
        clients: new Map(),
        chatHistory: [],
        pendingLeaves: new Map(),
        announcedJoins: new Set(),
        takenLinks: [],
        bannedMembers: new Map(p.bans.map((b) => [b.userId, b])),
        hostGraceUntil: now + config.hostGraceMs,
      };
      this.rooms.set(p.roomId, room);
      this.closedRooms.delete(p.roomId);
      room.hostGraceTimer = setTimeout(() => this.electHostIfMissing(room), config.hostGraceMs);
      room.cleanupTimer = setTimeout(() => this.closeEmptyRoom(room), config.hostGraceMs + EMPTY_ROOM_TTL_MS);
      room.hostGraceTimer.unref?.();
      room.cleanupTimer.unref?.();
      restored++;
    }
    if (restored) {
      console.log(`[WatchParty] ♻️ ${restored} sala(s) restaurada(s) do Redis; o Host antigo tem ${Math.round(config.hostGraceMs / 1000)} s para voltar.`);
    }
    return restored;
  }

  // ───────────── voto para pular abertura/encerramento ─────────────

  /** Quantas pessoas (IDs únicos, sem o sufixo de aba) há na sala agora. */
  private memberIds(room: RoomInternal): Set<string> {
    return new Set(Array.from(room.clients.values()).map((c) => baseUserId(c.userId)));
  }

  /** Mais da metade da sala (o Host conta na sala, mas não vota: ele pula direto). */
  private skipVotesNeeded(room: RoomInternal): number {
    return Math.floor(this.memberIds(room).size / 2) + 1;
  }

  private skipVoteState(room: RoomInternal): SkipVoteState | null {
    const v = room.skipVote;
    if (!v) return null;
    return { start: v.start, target: v.target, votes: v.voters.size, needed: this.skipVotesNeeded(room), voters: [...v.voters] };
  }

  /** Capítulo da mídia da sala que bate com o pedido: o destino do pulo vem da lista do Host, nunca do voto. */
  private findChapter(room: RoomInternal, start: number, target: number) {
    return room.media?.chapters?.find(
      (c) => c.endTime !== undefined && Math.abs(c.startTime - start) < 0.5 && Math.abs(c.endTime - target) < 0.5 && c.endTime > c.startTime
    );
  }

  private clearSkipVote(room: RoomInternal) {
    if (!room.skipVote) return;
    room.skipVote = undefined;
    this.broadcast(room, { type: 'skip:votes', skip: null });
  }

  /**
   * Confere a votação depois de qualquer mudança (voto, entrada ou saída de alguém): tira votos de quem saiu, avisa a sala
   * quando algo mudou e, se passou da metade, manda o Host pular (o seek continua sendo dele).
   */
  private refreshSkipVote(room: RoomInternal) {
    const v = room.skipVote;
    if (!v) return;
    const present = this.memberIds(room);
    for (const id of [...v.voters]) if (!present.has(id)) v.voters.delete(id);
    const needed = this.skipVotesNeeded(room);

    if (v.voters.size >= needed) {
      const { start, target } = v;
      room.skipVote = undefined;
      console.log(`[WatchParty] ⏭️ Sala "${room.roomId}" aprovou pular ${start.toFixed(1)}s → ${target.toFixed(1)}s (${v.voters.size}/${needed}).`);
      this.sendSystemChat(room, `⏭️ A sala votou para pular (${v.voters.size}/${present.size}).`);
      for (const [ws, c] of room.clients) if (c.userId === room.hostId) this.send(ws, { type: 'skip:passed', start, target });
      this.broadcast(room, { type: 'skip:votes', skip: null });
      return;
    }
    if (v.voters.size === 0) {
      room.skipVote = undefined;
      this.broadcast(room, { type: 'skip:votes', skip: null });
      return;
    }
    const signature = `${v.voters.size}/${needed}/${[...v.voters].sort().join(',')}`;
    if (signature === v.lastBroadcast) return;
    v.lastBroadcast = signature;
    this.broadcast(room, { type: 'skip:votes', skip: this.skipVoteState(room) });
  }

  private handleSkipVote(room: RoomInternal, session: ClientSession, msg: { start: number; target: number; vote: boolean }) {
    // Host pula direto pelo botão dele; voto de quem sai do que a sala conhece não vale
    if (baseUserId(session.userId) === baseUserId(room.hostId)) return;
    if (!Number.isFinite(msg.start) || !Number.isFinite(msg.target)) return;
    const chapter = this.findChapter(room, msg.start, msg.target);
    if (!chapter || chapter.endTime === undefined) return;

    const voter = baseUserId(session.userId);
    // Só uma votação por vez: um voto em outro capítulo começa uma nova (a anterior já não vale: o vídeo andou)
    if (!room.skipVote || room.skipVote.start !== chapter.startTime) {
      if (!msg.vote) return;
      room.skipVote = { start: chapter.startTime, target: chapter.endTime, voters: new Set(), lastBroadcast: '' };
    }
    if (msg.vote) room.skipVote.voters.add(voter);
    else room.skipVote.voters.delete(voter);
    this.refreshSkipVote(room);
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
    this.refreshSkipVote(room);
  }

  /** Links da sala que passam pela troca por id (mídia, fila e o que acabou de sair dela). */
  private linksFor(room: RoomInternal): LinkEntry[] {
    const now = Date.now();
    room.takenLinks = room.takenLinks.filter((l) => now - l.at < TAKEN_LINK_TTL_MS);
    const links = linksOf(room);
    for (const t of room.takenLinks) if (!links.some((l) => l.id === t.id)) links.push(t);
    return links;
  }

  /** O link de verdade por trás de um id da sala (as rotas com `?url=` usam). */
  public resolveLink(roomId: string, id: string): string | null {
    const room = this.rooms.get(roomId);
    if (!room || !isLinkId(id)) return null;
    return (resolveLinkId(room, id) ?? this.linksFor(room).find((l) => l.id === id) ?? null)?.url ?? null;
  }

  public send(ws: WebSocket, message: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        let payload = JSON.stringify(message);
        const session = this.sessions.get(ws);
        const room = session && this.rooms.get(session.roomId);
        if (room && payload.includes('http')) payload = scrubFor(this.linksFor(room), session!.userId, payload);
        ws.send(payload);
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
        const sv = currentRoom.skipVote;
        if (sv && (currentRoom.playback.position < sv.start - 0.5 || currentRoom.playback.position >= sv.target)) this.clearSkipVote(currentRoom);

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

      case 'playlist:add': {
        const url = typeof msg.url === 'string' ? msg.url.trim() : '';
        if (!/^https?:\/\//i.test(url) || url.length > 4096) return;
        if (currentRoom.playlist.length >= PLAYLIST_MAX_ITEMS) return;
        // O mesmo vídeo duas vezes na fila é quase sempre clique repetido; a Home já avisa quem tentou
        if (currentRoom.playlist.some((i) => playlistUrlKey(i.url) === playlistUrlKey(url))) return;
        const title = (typeof msg.title === 'string' ? msg.title.trim() : '').slice(0, 200) || 'Vídeo';
        currentRoom.playlist.push({
          id: `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          url,
          title,
          mimeType: typeof msg.mimeType === 'string' ? msg.mimeType.slice(0, 100) : undefined,
          fingerprint: typeof msg.fingerprint === 'string' && FINGERPRINT_RE.test(msg.fingerprint) ? msg.fingerprint : undefined,
          addedById: clientSession.userId,
          addedBy: clientSession.username,
        });
        this.sendSystemChat(currentRoom, `➕ ${clientSession.username} adicionou à fila: "${title}"`);
        // Sonda o link já: o primeiro acesso a um vídeo novo é o que o TorBox/Torrentio limita (429), e é melhor
        // isso acontecer agora, sem ninguém esperando, do que na hora de tocar
        if (!/youtube/i.test(msg.mimeType || '')) warmUpMedia(url);
        this.broadcast(currentRoom, { type: 'playlist:update', playlist: currentRoom.playlist });
        break;
      }

      case 'playlist:remove': {
        const item = currentRoom.playlist.find((i) => i.id === msg.itemId);
        // Quem adicionou pode tirar o próprio item; o Host tira qualquer um
        if (!item || (!isHost && item.addedById !== clientSession.userId)) return;
        currentRoom.playlist = currentRoom.playlist.filter((i) => i.id !== item.id);
        this.sendSystemChat(currentRoom, `➖ ${clientSession.username} removeu da fila: "${item.title}"`);
        this.broadcast(currentRoom, { type: 'playlist:update', playlist: currentRoom.playlist });
        break;
      }

      case 'playlist:move': {
        if (!isHost) return;
        const from = currentRoom.playlist.findIndex((i) => i.id === msg.itemId);
        const to = Number.isInteger(msg.toIndex) ? (msg.toIndex as number) : msg.direction === 'up' ? from - 1 : msg.direction === 'down' ? from + 1 : -1;
        if (from < 0 || to < 0 || to >= currentRoom.playlist.length || to === from) return;
        const [moved] = currentRoom.playlist.splice(from, 1);
        currentRoom.playlist.splice(to, 0, moved);
        this.broadcast(currentRoom, { type: 'playlist:update', playlist: currentRoom.playlist });
        break;
      }

      case 'playlist:take': {
        if (!isHost) return;
        const taken = currentRoom.playlist.find((i) => i.id === msg.itemId);
        if (!taken) return;
        // O `media:set` do vídeo tirado chega logo depois, ainda com o id dele
        currentRoom.takenLinks = [...this.linksFor(currentRoom).filter((l) => l.url === taken.url).map((l) => ({ ...l, at: Date.now() })), ...currentRoom.takenLinks].slice(0, 5);
        currentRoom.playlist = currentRoom.playlist.filter((i) => i.id !== msg.itemId);
        this.broadcast(currentRoom, { type: 'playlist:update', playlist: currentRoom.playlist });
        break;
      }

      case 'media:set': {
        if (!isHost) return;
        // O Host toca o link que enviou agora ou, pelo id, o de um item da fila (que continua sendo de quem o adicionou)
        let mediaUrl = msg.media.url;
        let ownerId = clientSession.userId;
        if (isLinkId(mediaUrl)) {
          const known = this.linksFor(currentRoom).find((l) => l.id === mediaUrl);
          if (!known) return;
          mediaUrl = known.url;
          ownerId = known.ownerId;
        }
        const newGeneration = (currentRoom.media?.generation || 0) + 1;
        currentRoom.media = {
          generation: newGeneration,
          url: mediaUrl,
          ownerId,
          fingerprint: typeof msg.media.fingerprint === 'string' && FINGERPRINT_RE.test(msg.media.fingerprint) ? msg.media.fingerprint : undefined,
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

        this.clearSkipVote(currentRoom);
        console.log(`[WatchParty] 🎬 Nova mídia definida na sala "${currentRoom.roomId}": "${msg.media.title}"`);
        // Trocou de vídeo: o envio que estava tocando (e mais nenhum item da sala) pode sair do disco
        pruneRoomUploads(currentRoom.roomId, this.referencedUploadIds(currentRoom.roomId));
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

      case 'media:chapters': {
        const chaptersUrl = isLinkId(msg.url) ? this.resolveLink(currentRoom.roomId, msg.url) : msg.url;
        if (!isHost || !currentRoom.media || chaptersUrl !== currentRoom.media.url || !Array.isArray(msg.chapters)) return;
        // Dado do cliente: só números finitos e títulos curtos, no máximo 200 capítulos
        const chapters = msg.chapters
          .slice(0, 200)
          .filter((c) => c && Number.isFinite(c.startTime) && (c.endTime === undefined || Number.isFinite(c.endTime)))
          .map((c) => ({ startTime: c.startTime, endTime: c.endTime, title: String(c.title ?? '').slice(0, 200) }));
        currentRoom.media = { ...currentRoom.media, chapters: chapters as any };
        this.schedulePersist(currentRoom);
        break;
      }

      case 'skip:vote': {
        this.handleSkipVote(currentRoom, clientSession, msg);
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
        const targetUserId = baseUserId(String(msg.targetUserId));
        if (targetUserId === baseUserId(clientSession.userId)) return; // o Host não bane a si mesmo (nem a própria outra aba)

        let bannedName = 'Usuário';
        let bannedAvatar: string | undefined;
        let bannedPlatform: 'discord' | 'web' = 'web';

        for (const [targetWs, targetSession] of Array.from(currentRoom.clients.entries())) {
          if (baseUserId(targetSession.userId) === targetUserId) {
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
        const targetUserId = baseUserId(String(msg.targetUserId));
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

    if (PERSISTED_MESSAGES.has(msg.type)) {
      this.schedulePersist(currentRoom, msg.type === 'playback:timeline' ? TIMELINE_PERSIST_GAP_MS : 250);
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
