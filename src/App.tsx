import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Ban, Lock, UserX } from 'lucide-react';
// Player (Vidstack, legendas, hooks) e Catálogo saem do pacote inicial: a Home abre sem baixá-los.
const loadVideoPlayer = () => import('./components/VideoPlayer').then((m) => ({ default: m.VideoPlayer }));
const VideoPlayer = lazy(loadVideoPlayer);
const CatalogTab = lazy(() => import('./components/catalog/CatalogTab').then((m) => ({ default: m.CatalogTab })));
import { RoomShell } from './components/room/RoomShell';
import type { RoomSidebarTab } from './components/room/RoomSidebar';
import { RoomLobbyModal } from './components/RoomLobbyModal';
import { UsernameModal, getLastUsername, shouldSkipNamePrompt } from './components/UsernameModal';
import { SubtitleModal } from './components/SubtitleModal';
import { Modal, ModalHeader, PrimaryButton, Spinner, TextButton, TextInput } from './components/ui';
import { readDetailFromUrl, readSearchFromUrl, readSeasonFromUrl } from './lib/searchUrl';
import { canonicalizeCatalogUrl, pushTabUrl, tabFromPath } from './lib/homeRoute';
import { HomeLayout, HomeTab } from './components/home/HomeLayout';
import { HomeHero } from './components/home/HomeHero';
import { LastRoomCard } from './components/home/LastRoomCard';
import { RoomEntryCard, type CreateRoomInput } from './components/home/RoomEntryCard';
import { StreamStep } from './components/home/StreamStep';
import { JoinError, checkRoom } from './components/home/RoomSteps';
import { RoomsTab } from './components/home/RoomsTab';
import { StatusTab } from './components/home/StatusTab';
import type { WatchIntent } from './components/catalog/CatalogTab';
import type { StreamOption } from './lib/streams';
import type { CommitOptions } from './components/home/types';
import { MediaPayload, SubtitleTrack, CatalogSeriesContext } from './types/media';
import { CatalogEpisode, episodeTag, loadActiveSeriesContext, saveActiveSeriesContext } from './lib/catalog';
import type { PlaylistItem, RoomInitialSettings } from './types/sync';
import { logger } from './lib/logger';
import { clearLastRoom, saveLastRoom } from './lib/lastRoom';
import { refFromSeriesContext, startPlayback, type CatalogRef } from './lib/continueWatching';
import { describeSourceForLog } from './lib/mediaLog';
import { shareableFingerprint } from './lib/media';
import { discordManager, DiscordContextState } from './lib/discord';
import { syncManager } from './lib/sync';
import { generateRoomCode, readRoomFromUrl, setRoomInUrl } from './lib/roomCode';
import { RecentStream, loadRecentStreams, pushRecentStream, saveRecentStreams } from './lib/recent';
import { t, useLang } from './lib/i18n';
import { ScreenShareProvider } from './components/player/ScreenShareContext';
import { streamMediaInfo } from './lib/streamMime';

type HomeStep = 'entry' | 'stream';

/** Enquanto o pedaço sob demanda (player/catálogo) baixa. */
const PanelFallback: React.FC = () => (
  <div role="status" aria-label="Carregando" className="w-full min-h-[320px] flex items-center justify-center">
    <Spinner size={28} className="text-lu-accent" />
  </div>
);

const EMPTY_PAYLOAD: MediaPayload = {
  url: '',
  mimeType: 'video/x-matroska',
  title: '',
  chapters: [],
  subtitles: [],
  audioTracks: [],
};

export default function App() {
  // Trocar o idioma remonta a árvore inteira (a troca só existe na Home, sem vídeo tocando)
  const lang = useLang();
  const [view, setView] = useState<'home' | 'player'>('home');
  // Busca, título e temporada vindos do endereço valem só na abertura do catálogo (ver o efeito de `homeTab` abaixo)
  const initialSearch = useRef(readSearchFromUrl());
  const initialDetail = useRef(readDetailFromUrl());
  const initialSeason = useRef(readSeasonFromUrl());
  // A aba vem da rota (/catalog, /home, /status); `/` com busca ou título do catálogo (sem sala) é o catálogo
  const [homeTab, setHomeTab] = useState<HomeTab>(() => {
    const fromPath = tabFromPath(window.location.pathname);
    if (fromPath !== 'room') return fromPath;
    const hasRoom = Boolean(readRoomFromUrl());
    return (initialSearch.current || initialDetail.current) && !hasRoom ? 'catalog' : 'room';
  });
  const [homeStep, setHomeStep] = useState<HomeStep>('entry');
  const [joinPrefill, setJoinPrefill] = useState<{ code: string; error: JoinError | null }>({ code: '', error: null });
  const [watchIntent, setWatchIntent] = useState<WatchIntent | null>(null);

  const [currentPayload, setCurrentPayload] = useState<MediaPayload>(EMPTY_PAYLOAD);
  // Vídeo vindo da fila começa sozinho (o anterior já tinha acabado)
  const [autoPlayNext, setAutoPlayNext] = useState(false);
  const currentUrlRef = useRef('');
  currentUrlRef.current = currentPayload.url;
  const [pendingSubtitles, setPendingSubtitles] = useState<SubtitleTrack[]>([]);
  const [recentStreams, setRecentStreams] = useState<RecentStream[]>(loadRecentStreams);

  const [subtitleModal, setSubtitleModal] = useState<'pending' | 'current' | null>(null);
  const [discordState, setDiscordState] = useState<DiscordContextState>(() => discordManager.getState());
  const [syncStatus, setSyncStatus] = useState(() => syncManager.getStatus());
  const [showRoomModal, setShowRoomModal] = useState(false);
  // Ação que espera o apelido (criar ou entrar em sala sem nome definido nesta aba)
  const [nameGate, setNameGate] = useState<{ action: () => void; label: string; onCancel?: () => void } | null>(null);
  const [isWatchPartyOpen, setIsWatchPartyOpen] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 1024 : true
  );
  const [sidebarTab, setSidebarTab] = useState<RoomSidebarTab>('chat');
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [kickBanAlert, setKickBanAlert] = useState<{ title: string; message: string; type: 'kicked' | 'banned' | 'locked' } | null>(null);
  const [passwordPrompt, setPasswordPrompt] = useState<{ roomCode: string; error?: string } | null>(null);
  const [passwordDraft, setPasswordDraft] = useState('');
  const [seriesContext, setSeriesContext] = useState<CatalogSeriesContext | null>(() => loadActiveSeriesContext());

  // Com a Home aberta e a rede livre, já baixa o player: entrar numa sala fica instantâneo
  useEffect(() => {
    const idle = (window as any).requestIdleCallback as ((cb: () => void) => number) | undefined;
    const run = () => void loadVideoPlayer().catch(() => {});
    const handle = idle ? idle(run) : window.setTimeout(run, 1500);
    return () => {
      if (!idle) window.clearTimeout(handle);
    };
  }, []);

  // Já recebeu o estado da sala nesta conexão? (entrada recusada por ban nunca chega a recebê-lo)
  const wasInRoomRef = useRef(false);
  const activeRoomIdRef = useRef<string | null>(null);
  const initialRoomPendingRef = useRef<boolean>(
    typeof window !== 'undefined' && !discordManager.isDiscordActivity() && Boolean(readRoomFromUrl())
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  const leaveToHomeRef = useRef<() => void>(() => {});
  const isWatchPartyOpenRef = useRef(isWatchPartyOpen);
  isWatchPartyOpenRef.current = isWatchPartyOpen;
  const sidebarTabRef = useRef(sidebarTab);
  sidebarTabRef.current = sidebarTab;

  useEffect(() => {
    if (isWatchPartyOpen && sidebarTab === 'chat') setUnreadChatCount(0);
  }, [isWatchPartyOpen, sidebarTab]);

  // Proteção contra fechamento ou recarregamento acidental da guia enquanto estiver numa sala
  useEffect(() => {
    if (view !== 'player' || !syncStatus.isConnected || discordState.isEmbedded) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [view, syncStatus.isConnected, discordState.isEmbedded]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view, homeTab, homeStep]);

  // A aba vai para a rota. Dentro do Discord a Activity roda sob o proxy do Discord: ali o endereço não muda.
  useEffect(() => {
    if (view !== 'home' || discordManager.getState().isEmbedded) return;
    // Preserva /room/:code (ou ?room=...) apenas enquanto o check inicial de auto-entrada está em andamento
    if (homeTab === 'room' && initialRoomPendingRef.current && readRoomFromUrl()) return;
    if (homeTab === 'catalog' && tabFromPath(window.location.pathname) !== 'catalog') canonicalizeCatalogUrl();
    else pushTabUrl(homeTab);
    // Sair do catálogo (para a Sala ou o Status) e voltar abre o catálogo limpo, não a busca ou o título do endereço da abertura
    if (homeTab !== 'catalog') {
      initialSearch.current = '';
      initialDetail.current = null;
      initialSeason.current = null;
    }
  }, [homeTab, view]);

  // Voltar/avançar do navegador entre as abas (e sair do player ao voltar de /room/:code)
  useEffect(() => {
    const onPop = () => {
      if (viewRef.current === 'player' && !readRoomFromUrl()) {
        leaveToHomeRef.current();
      }
      const tab = tabFromPath(window.location.pathname);
      setHomeTab((current) => (current === tab ? current : tab));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const goHome = useCallback((tab: HomeTab = 'room', step: HomeStep = 'entry') => {
    setView('home');
    setHomeTab(tab);
    setHomeStep(step);
    // A intenção "assistir este título" vale só para o passo aberto pelo catálogo
    setWatchIntent(null);
    setIsWatchPartyOpen(false);
  }, []);

  const joinRoom = useCallback((code: string) => {
    startPlayback(null); // quem entra numa sala só assiste: o que ele tocou antes não é dele aqui
    setRoomInUrl(code);
    wasInRoomRef.current = false;
    syncManager.connect(code);
    setIsWatchPartyOpen(typeof window !== 'undefined' ? window.innerWidth >= 1024 : true);
    setView('player');
  }, []);

  /**
   * Pergunta o apelido antes de criar/entrar numa sala (preenchido com o último usado).
   * Com "Não perguntar de novo" marcado, usa o último apelido direto.
   */
  const withName = useCallback((action: () => void, label: string, onCancel?: () => void) => {
    if (shouldSkipNamePrompt()) {
      syncManager.setUserProfile(getLastUsername());
      action();
    } else {
      setNameGate({ action, label, onCancel });
    }
  }, []);

  /** Série do vídeo em reprodução (menu de episódios): o estado e o `sessionStorage` andam juntos. */
  const updateSeriesContext = useCallback((ctx: CatalogSeriesContext | null) => {
    setSeriesContext(ctx);
    saveActiveSeriesContext(ctx);
  }, []);

  /** Sai da sala de verdade: desconecta, limpa /room/:code, descarrega o vídeo e volta para a tela inicial. */
  const leaveToHome = useCallback(() => {
    initialRoomPendingRef.current = false;
    activeRoomIdRef.current = null;
    const leftCode = syncManager.getRoomState()?.roomId;
    if (leftCode && !discordManager.isDiscordActivity()) saveLastRoom(leftCode, Date.now(), true); // a hora de agora é a de sair
    if (!discordManager.isDiscordActivity()) syncManager.leaveRoom();
    setRoomInUrl(null);
    setCurrentPayload(EMPTY_PAYLOAD);
    updateSeriesContext(null);
    setPendingSubtitles([]);
    setUnreadChatCount(0);
    goHome('room');
  }, [goHome, updateSeriesContext]);
  leaveToHomeRef.current = leaveToHome;

  /** Entra numa sala, pedindo o apelido antes se for preciso. */
  const requestJoin = useCallback(
    (code: string) => {
      withName(
        () => joinRoom(code),
        t('Entrar na sala'),
        () => {
          setRoomInUrl(null);
          goHome('room');
        }
      );
    },
    [joinRoom, withName, goHome]
  );

  // Rich Presence do Discord: título do vídeo e quantas pessoas estão na sala
  const presenceTitle = view === 'player' ? currentPayload.title : '';
  useEffect(() => {
    if (!discordState.isEmbedded || !discordState.user) return;
    const push = () => {
      void discordManager.setPresence({ title: presenceTitle, people: syncManager.getStatus().membersCount });
    };
    push();
    return syncManager.subscribeState(push);
  }, [discordState.isEmbedded, discordState.user, presenceTitle]);

  useEffect(() => {
    const unsubDiscord = discordManager.subscribe((st) => {
      setDiscordState({ ...st });
      if (st.isReady) {
        syncManager.syncWithDiscord(st);
        if (st.user && st.user.id !== 'mock_discord_user' && st.user.id !== 'standalone_user') {
          setShowRoomModal(false);
        }
      }
    });

    discordManager.initialize();

    let cancelled = false;

    // No navegador: /room/CODE (ou ?room=CODE legado) entra direto na sala (ou mostra erro em "Entrar na sala")
    if (!discordManager.isDiscordActivity()) {
      const validCode = readRoomFromUrl();
      if (validCode) {
        checkRoom(validCode).then((info) => {
          initialRoomPendingRef.current = false;
          // Se o usuário já trocou de aba ou saiu da URL da sala enquanto verificávamos, não sequestra a navegação
          if (cancelled || readRoomFromUrl() !== validCode) return;
          if (info && !info.exists) {
            setRoomInUrl(null);
            setJoinPrefill({ code: validCode, error: info.closed ? 'closed' : 'not_found' });
            setHomeTab('room');
            setHomeStep('entry');
            setView('home');
          } else {
            requestJoin(validCode);
          }
        });
      } else {
        initialRoomPendingRef.current = false;
      }
    }

    const unsubSync = syncManager.subscribeState(() => {
      setSyncStatus(syncManager.getStatus());
      const room = syncManager.getRoomState();
      if (room) {
        const switchedRoom = Boolean(activeRoomIdRef.current && activeRoomIdRef.current !== room.roomId);
        activeRoomIdRef.current = room.roomId;
        wasInRoomRef.current = true;
        setPasswordPrompt(null);
        setPasswordDraft('');
        if (!discordManager.isDiscordActivity()) {
          if (readRoomFromUrl() !== room.roomId) setRoomInUrl(room.roomId);
          // "Voltar à sala" na Home: lembra a sala (no Discord a sala é a da atividade, não precisa)
          saveLastRoom(room.roomId);
        }
        // Ao trocar de sala pelo painel ("Trocar sala"), limpa vídeo/episódio/chat não lido da sala anterior
        if (switchedRoom) {
          updateSeriesContext(null);
          setPendingSubtitles([]);
          setUnreadChatCount(0);
          if (room.media?.url) {
            currentUrlRef.current = room.media.url;
            setCurrentPayload({
              url: room.media.url,
              title: room.media.title,
              mimeType: 'video/x-matroska',
              chapters: room.media.chapters || [],
              subtitles: room.media.subtitles || [],
              audioTracks: room.media.audioTracks || [],
              fingerprint: room.media.fingerprint,
            });
          } else {
            currentUrlRef.current = '';
            setCurrentPayload(EMPTY_PAYLOAD);
          }
        }
      }
      // Player vazio numa sala que já tem vídeo (ex.: o Host recarregou a página): carrega o vídeo da sala.
      // O listener de mídia só cobre espectadores, porque assume que o Host já está com o vídeo aberto.
      if (room?.media?.url && !currentUrlRef.current) {
        currentUrlRef.current = room.media.url;
        logger.info(`[Sala] Retomando o vídeo da sala: "${room.media.title}"`);
        setCurrentPayload({
          url: room.media.url,
          title: room.media.title,
          mimeType: 'video/x-matroska',
          chapters: room.media.chapters || [],
          subtitles: room.media.subtitles || [],
          audioTracks: room.media.audioTracks || [],
          fingerprint: room.media.fingerprint,
        });
      }
    });

    const unsubMedia = syncManager.subscribeMedia((media, _generation, _triggeredBy, username) => {
      if (media && !syncManager.isRoomHost()) {
        startPlayback(null);
        setCurrentPayload({
          url: media.url,
          title: media.title,
          mimeType: 'video/x-matroska',
          chapters: media.chapters || [],
          subtitles: media.subtitles || [],
          audioTracks: media.audioTracks || [],
          fingerprint: media.fingerprint,
        });
      }
    });

    const unsubChat = syncManager.subscribeChat((msg) => {
      if (msg.isSystem) return;
      if (msg.userId === syncManager.getUser().id) return;
      if (!(isWatchPartyOpenRef.current && sidebarTabRef.current === 'chat')) {
        setUnreadChatCount((c) => c + 1);
      }
    });

    const unsubError = syncManager.subscribeError((_errorMsg, code) => {
      const kickedFromInside = wasInRoomRef.current;
      wasInRoomRef.current = false;
      if (code === 'banned' || code === 'kicked') {
        clearLastRoom(); // não dá para voltar
        setRoomInUrl(null);
        setCurrentPayload(EMPTY_PAYLOAD);
        setPendingSubtitles([]);
        setIsWatchPartyOpen(false);
        setView('home');
        setHomeTab('room');
        setHomeStep('entry');
      }
      if (code === 'banned') {
        setKickBanAlert(
          kickedFromInside
            ? {
                title: t('Você foi banido da sala'),
                message: t('O Host desta sala baniu você permanentemente. Você voltou para a tela inicial.'),
                type: 'banned',
              }
            : {
                title: t('Você está banido desta sala'),
                message: t('O Host desta sala baniu você, então não dá pra entrar nela de novo.'),
                type: 'banned',
              }
        );
      } else if (code === 'kicked') {
        setKickBanAlert({
          title: t('Você foi expulso da sala'),
          message: t('O Host removeu você da sala. Você voltou para a tela inicial.'),
          type: 'kicked',
        });
      } else if (code === 'password_required' || code === 'wrong_password' || code === 'rate_limited') {
        const targetRoom = syncManager.getStatus().roomId;
        if (targetRoom) {
          setPasswordPrompt({
            roomCode: targetRoom,
            error:
              code === 'wrong_password'
                ? t('Senha incorreta. Tente novamente.')
                : code === 'rate_limited'
                ? t('Muitas tentativas de senha. Aguarde um momento.')
                : undefined,
          });
        }
      } else if (code === 'room_locked') {
        const currentRoom = syncManager.getRoomState();
        if (!currentRoom) {
          syncManager.leaveRoom();
          setRoomInUrl(null);
          setView('home');
          setHomeTab('room');
          setHomeStep('entry');
        }
        setKickBanAlert({
          title: t('Sala trancada'),
          message: t('Esta sala está trancada pelo Host e não aceita novos participantes agora.'),
          type: 'locked',
        });
      }
    });

    return () => {
      cancelled = true;
      unsubDiscord();
      unsubSync();
      unsubMedia();
      unsubChat();
      unsubError();
    };
  }, []);

  /** Garante uma sala em que você é o Host e devolve o código. */
  const ensureRoom = useCallback((initialSettings?: RoomInitialSettings): string => {
    const st = syncManager.getStatus();
    if (discordManager.isDiscordActivity() && st.roomId) return st.roomId;
    if ((st.isConnected || st.isConnecting) && st.isHost && st.roomId) return st.roomId;
    if (st.isConnected || st.isConnecting) syncManager.leaveRoom();
    const code = generateRoomCode();
    setRoomInUrl(code);
    wasInRoomRef.current = false;
    syncManager.connect(code, undefined, initialSettings);
    logger.info(`[Sala] Sala ${code} criada (você é o Host)`);
    return code;
  }, []);

  const emitCurrentMedia = (payload: MediaPayload) => {
    syncManager.emitMedia({
      url: payload.url,
      title: payload.title,
      duration: 0,
      chapters: payload.chapters,
      subtitles: payload.subtitles,
      audioTracks: payload.audioTracks,
      // Os outros da sala recebem só um id no lugar do link: a identidade do vídeo vai junto para dividirem o mesmo cache
      fingerprint: payload.fingerprint ?? shareableFingerprint(payload.url),
    });
  };

  /** Já é Host de uma sala aberta (trocar o vídeo não pede apelido de novo). */
  const isHostingRoom = () => {
    const st = syncManager.getStatus();
    return (st.isConnected || st.isConnecting) && st.isHost && Boolean(st.roomId);
  };

  const commitMedia = (payload: MediaPayload, options: CommitOptions = {}, named = false) => {
    if (!named && !isHostingRoom()) {
      withName(() => commitMedia(payload, options, true), t('Criar sala'));
      return;
    }
    const merged: MediaPayload = { ...payload, subtitles: [...(payload.subtitles || []), ...pendingSubtitles] };
    setPendingSubtitles([]);
    setAutoPlayNext(false);
    setCurrentPayload(merged);
    setWatchIntent(null);
    // O menu de episódios só vale para o vídeo que veio de um episódio do catálogo; qualquer outro (link colado, filme, envio) o zera
    updateSeriesContext(options.seriesContext ?? null);
    startPlayback(options.continueRef ?? null); // só o que veio do catálogo vira "continuar assistindo" (e abre de onde parou)
    if (options.recent) setRecentStreams((prev) => pushRecentStream(prev, merged.url, merged.title || ''));
    logger.info(`[Mídia] Abrindo "${merged.title}" (${describeSourceForLog(merged.url)})`);

    // Cria (ou reaproveita) a sala como Host e já abre o player; o código fica no cabeçalho para compartilhar
    ensureRoom(options.initialRoomSettings);
    emitCurrentMedia(merged);
    setIsWatchPartyOpen(typeof window !== 'undefined' ? window.innerWidth >= 1024 : true);
    setView('player');
  };

  /** Um stream escolhido no detalhe do catálogo ("Onde assistir"): cria a sala e abre o player. */
  const playStream = (stream: StreamOption, title: string, context?: CatalogSeriesContext, movie?: CatalogRef) => {
    const { mimeType, isMkv } = streamMediaInfo(stream.url, stream.filename);
    const roomName = title.trim().slice(0, 48);
    commitMedia(
      {
        url: stream.url,
        title,
        mimeType,
        chapters: [],
        subtitles: [],
        audioTracks: [],
        isMkv,
      },
      {
        seriesContext: context,
        continueRef: context ? refFromSeriesContext(context) : movie,
        initialRoomSettings: !isHostingRoom()
          ? { ...(roomName ? { name: roomName } : {}), visibility: 'public' }
          : undefined,
      }
    );
  };

  /** Seleciona outro episódio a partir do menu de episódios no player. */
  const playEpisodeStream = (episode: CatalogEpisode, stream: StreamOption) => {
    if (seriesContext) {
      const updated: CatalogSeriesContext = {
        ...seriesContext,
        currentEpisodeId: episode.id,
        season: episode.season,
        episode: episode.episode,
      };
      const title = `${updated.seriesTitle} · ${episodeTag(episode.season, episode.episode)}`;
      playStream(stream, title, updated);
    } else {
      playStream(stream, stream.title || '');
    }
  };

  /** Carrega um item vindo da fila ou de um pedido aprovado com playNow. */
  const loadQueuedItem = useCallback(
    (item: PlaylistItem, takeFromQueue: boolean) => {
      if (!syncManager.isRoomHost()) return;
      if (takeFromQueue) syncManager.emitPlaylistTake(item.id);
      const payload: MediaPayload = {
        url: item.url,
        title: item.title,
        mimeType: item.mimeType,
        chapters: [],
        subtitles: [],
        audioTracks: [],
        // O link pode ser só um id (item de outra pessoa): o tipo vem do que quem adicionou informou
        isMkv: /matroska/i.test(item.mimeType || '') || /\.mkv|torrentio/i.test(item.url),
        fingerprint: item.fingerprint,
      };
      logger.info(`[Fila] Tocando "${item.title}"`);
      setPendingSubtitles([]);
      setAutoPlayNext(true);
      updateSeriesContext(null); // item da fila não vem do catálogo: sem menu de episódios
      startPlayback(null);
      setCurrentPayload(payload);
      emitCurrentMedia(payload);
    },
    [updateSeriesContext]
  );

  const playPlaylistItem = useCallback((item: PlaylistItem) => loadQueuedItem(item, true), [loadQueuedItem]);

  useEffect(() => syncManager.subscribeRequestPlay((item) => loadQueuedItem(item, false)), [loadQueuedItem]);

  // Watch Party modal (aberto pelo painel quando você está sozinho)
  const handleCreateRoom = (code: string, username: string) => {
    if (username) syncManager.setUserProfile(username);
    setRoomInUrl(code);
    syncManager.connect(code);
    setShowRoomModal(false);
    if (currentPayload.url) emitCurrentMedia(currentPayload);
  };

  const handleJoinRoomFromLobby = (code: string, username: string) => {
    if (username) syncManager.setUserProfile(username);
    setShowRoomModal(false);
    joinRoom(code);
  };

  const addSubtitle = (track: SubtitleTrack) => {
    if (subtitleModal === 'pending') {
      setPendingSubtitles((prev) => [...prev, track]);
    } else {
      setCurrentPayload((prev) => ({ ...prev, subtitles: [...(prev.subtitles || []), track] }));
    }
  };

  const environment = discordState.isEmbedded ? 'discord' : 'web';
  const roomInfo = {
    connected: syncStatus.isConnected,
    code: syncStatus.roomId,
    members: Math.max(1, syncStatus.membersCount),
    isHost: syncStatus.isHost,
  };

  /** Cria uma sala vazia a partir da Home preservando nome, privacidade e senha opcional. */
  const createEmptyRoom = useCallback(
    (input: CreateRoomInput) => {
      withName(() => {
        setPendingSubtitles([]);
        setAutoPlayNext(false);
        currentUrlRef.current = '';
        setCurrentPayload(EMPTY_PAYLOAD);
        setWatchIntent(null);
        updateSeriesContext(null);
        startPlayback(null);
        setUnreadChatCount(0);
        ensureRoom({
          name: input.name,
          visibility: input.visibility,
          ...(input.password ? { password: input.password } : {}),
        });
        setIsWatchPartyOpen(typeof window !== 'undefined' ? window.innerWidth >= 1024 : true);
        setView('player');
      }, t('Criar sala'));
    },
    [ensureRoom, updateSeriesContext, withName]
  );

  const renderRoomTab = () => {
    if (homeStep === 'stream') {
      return (
        <StreamStep
          recentStreams={recentStreams}
          onRemoveRecent={(url) =>
            setRecentStreams((prev) => {
              const next = prev.filter((i) => i.url !== url);
              saveRecentStreams(next);
              return next;
            })
          }
          onClearRecent={() => {
            setRecentStreams([]);
            saveRecentStreams([]);
          }}
          intentTitle={watchIntent?.title}
          pendingSubtitles={pendingSubtitles.length}
          onAddSubtitle={() => setSubtitleModal('pending')}
          onBack={() => goHome('catalog')}
          onCommit={commitMedia}
        />
      );
    }

    return (
      <>
        <HomeHero />
        <LastRoomCard onRejoin={requestJoin} />
        <RoomEntryCard
          initialMode={joinPrefill.code || joinPrefill.error ? 'join' : 'create'}
          joinPrefill={joinPrefill}
          onCreateRoom={createEmptyRoom}
          onJoinRoom={requestJoin}
          onCatalog={() => setHomeTab('catalog')}
          onClearJoinPrefill={() => setJoinPrefill({ code: '', error: null })}
        />
      </>
    );
  };

  return (
    <ScreenShareProvider>
    <React.Fragment key={lang}>
      {view === 'home' ? (
        <HomeLayout
          tab={homeTab}
          stepKey={homeTab === 'room' ? homeStep : undefined}
          onTabChange={(tab) => {
            setHomeTab(tab);
            setWatchIntent(null);
            if (tab !== 'room') setHomeStep('entry');
          }}
          onLogo={() => goHome('room')}
          centered={homeTab === 'room' || homeTab === 'status'}
        >
          {homeTab === 'catalog' ? (
            <Suspense fallback={<PanelFallback />}>
              <CatalogTab
                initialQuery={initialSearch.current}
                initialDetail={initialDetail.current}
                initialSeason={initialSeason.current}
                onWatch={(intent) => {
                  setWatchIntent(intent);
                  setHomeTab('room');
                  setHomeStep('stream');
                }}
                onPlayStream={playStream}
                onCreateRoom={() => goHome('room')}
              />
            </Suspense>
          ) : homeTab === 'rooms' ? (
            <RoomsTab onJoinRoom={requestJoin} onCreateRoom={() => goHome('room')} />
          ) : homeTab === 'status' ? (
            <StatusTab environment={environment} room={roomInfo} />
          ) : (
            renderRoomTab()
          )}
        </HomeLayout>
      ) : (
        <RoomShell
          onHome={leaveToHome}
          room={roomInfo}
          environment={environment}
          hasSource={Boolean(currentPayload.url && currentPayload.url.trim())}
          sidebarOpen={isWatchPartyOpen}
          onToggleSidebar={() => setIsWatchPartyOpen((v) => !v)}
          onCloseSidebar={() => setIsWatchPartyOpen(false)}
          sidebarTab={sidebarTab}
          onSidebarTabChange={setSidebarTab}
          unreadChat={unreadChatCount}
          onOpenRoomLobby={() => setShowRoomModal(true)}
          onPlayQueueItem={playPlaylistItem}
          recentStreams={recentStreams}
          onRemoveRecent={(url) =>
            setRecentStreams((prev) => {
              const next = prev.filter((i) => i.url !== url);
              saveRecentStreams(next);
              return next;
            })
          }
          onClearRecent={() => {
            setRecentStreams([]);
            saveRecentStreams([]);
          }}
          pendingSubtitles={pendingSubtitles.length}
          onAddSubtitle={() => setSubtitleModal('pending')}
          ensureRoom={ensureRoom}
          requireName={(cb) => (isHostingRoom() ? cb() : withName(cb, t('Criar sala')))}
          onCommitMedia={commitMedia}
          onPlayCatalogStream={playStream}
          renderPlayer={({ roomState, onSelectMember, fullscreenDock, fullscreenSidebar, openMediaPicker }) => (
            <Suspense fallback={<PanelFallback />}>
              {/* key = URL: um vídeo novo (fila, Host trocando) nasce com estado limpo: áudio escolhido, posição, retomada */}
              <VideoPlayer
                key={currentPayload.url}
                source={{ src: currentPayload.url, type: currentPayload.mimeType, fingerprint: currentPayload.fingerprint }}
                title={currentPayload.title}
                chapters={currentPayload.chapters}
                subtitles={currentPayload.subtitles}
                audioTracks={currentPayload.audioTracks}
                onOpenRoomLobby={() => setShowRoomModal(true)}
                isWatchPartyOpen={isWatchPartyOpen}
                onToggleWatchParty={() => setIsWatchPartyOpen((prev) => !prev)}
                onCloseWatchParty={() => setIsWatchPartyOpen(false)}
                onBack={leaveToHome}
                onLeaveRoom={leaveToHome}
                autoPlay={autoPlayNext}
                seriesContext={seriesContext}
                onSelectEpisodeStream={playEpisodeStream}
                onPlayPlaylistItem={playPlaylistItem}
                onAddSubtitle={() => setSubtitleModal('current')}
                onChooseVideo={openMediaPicker}
                roomState={roomState}
                onSelectMember={onSelectMember}
                fullscreenDock={fullscreenDock}
                fullscreenSidebar={fullscreenSidebar}
                onMediaChangeRequested={(media) => {
                  setCurrentPayload({
                    url: media.url,
                    title: media.title,
                    mimeType: 'video/x-matroska',
                    chapters: media.chapters || [],
                    subtitles: media.subtitles || [],
                    audioTracks: media.audioTracks || [],
                    fingerprint: media.fingerprint,
                  });
                }}
              />
            </Suspense>
          )}
        />
      )}

      <SubtitleModal open={subtitleModal !== null} onClose={() => setSubtitleModal(null)} onAdd={addSubtitle} />

      <RoomLobbyModal
        isOpen={showRoomModal}
        onClose={() => setShowRoomModal(false)}
        onJoinRoom={handleJoinRoomFromLobby}
        onCreateRoom={handleCreateRoom}
        currentUsername={syncManager.hasCustomUsername() ? syncManager.getUser().username : ''}
      />

      <UsernameModal
        isOpen={nameGate !== null}
        actionLabel={nameGate?.label}
        onUsernameSet={() => {
          const gate = nameGate;
          setNameGate(null);
          gate?.action();
        }}
        onClose={() => {
          const gate = nameGate;
          setNameGate(null);
          gate?.onCancel?.();
        }}
      />

      {/* Senha para entrar em sala privada */}
      <Modal
        open={passwordPrompt !== null}
        onClose={() => {
          setPasswordPrompt(null);
          setPasswordDraft('');
          if (!syncManager.getRoomState()) leaveToHome();
        }}
        label={t('Sala privada')}
        width={400}
        className="!p-6 !gap-4"
      >
        <ModalHeader
          title={t('Sala privada')}
          description={t('Digite a senha para entrar na sala {code}.', { code: passwordPrompt?.roomCode || '' })}
          onClose={() => {
            setPasswordPrompt(null);
            setPasswordDraft('');
            if (!syncManager.getRoomState()) leaveToHome();
          }}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!passwordPrompt || !passwordDraft.trim()) return;
            syncManager.joinRoom(passwordPrompt.roomCode, passwordDraft.trim());
          }}
          className="flex flex-col gap-3"
        >
          <TextInput
            type="password"
            maxLength={64}
            placeholder={t('Senha da sala')}
            value={passwordDraft}
            onChange={(e) => setPasswordDraft(e.target.value)}
            autoFocus
          />
          {passwordPrompt?.error && (
            <p role="alert" className="m-0 text-[12.5px] text-lu-error">
              {passwordPrompt.error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <TextButton
              onClick={() => {
                setPasswordPrompt(null);
                setPasswordDraft('');
                if (!syncManager.getRoomState()) leaveToHome();
              }}
            >
              {t('Cancelar')}
            </TextButton>
            <PrimaryButton type="submit" disabled={!passwordDraft.trim()}>
              {t('Entrar na sala')}
            </PrimaryButton>
          </div>
        </form>
      </Modal>

      {/* Aviso · Expulso / Banido / Trancada */}
      <Modal open={kickBanAlert !== null} onClose={() => setKickBanAlert(null)} label={kickBanAlert?.title || ''} width={400} alert className="items-center text-center !gap-4">
        <div className="w-14 h-14 rounded-full bg-lu-error/12 border border-lu-error/30 flex items-center justify-center text-lu-error">
          {kickBanAlert?.type === 'banned' ? <Ban size={26} /> : kickBanAlert?.type === 'locked' ? <Lock size={26} /> : <UserX size={26} />}
        </div>
        <div>
          <h2 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">{kickBanAlert?.title}</h2>
          <p className="mt-2 mb-0 text-[14px] text-lu-muted">{kickBanAlert?.message}</p>
        </div>
        <PrimaryButton size="lg" block className="mt-1" onClick={() => setKickBanAlert(null)}>
          {t('Entendido')}
        </PrimaryButton>
      </Modal>
    </React.Fragment>
    </ScreenShareProvider>
  );
}
