import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Ban, UserX } from 'lucide-react';
// Player (Vidstack, legendas, hooks) e Catálogo saem do pacote inicial: a Home abre sem baixá-los.
const loadVideoPlayer = () => import('./components/VideoPlayer').then((m) => ({ default: m.VideoPlayer }));
const VideoPlayer = lazy(loadVideoPlayer);
const CatalogTab = lazy(() => import('./components/catalog/CatalogTab').then((m) => ({ default: m.CatalogTab })));
import { PlayerConsole } from './components/PlayerConsole';
import { PlayerPage } from './components/PlayerPage';
import { RoomLobbyModal } from './components/RoomLobbyModal';
import { UsernameModal, getLastUsername, shouldSkipNamePrompt } from './components/UsernameModal';
import { SubtitleModal } from './components/SubtitleModal';
import { Modal, PrimaryButton, Spinner } from './components/ui';
import { HomeLayout, HomeTab } from './components/home/HomeLayout';
import { RoomMenu, SourceStep } from './components/home/RoomMenu';
import { StreamStep } from './components/home/StreamStep';
import { UploadStep } from './components/home/UploadStep';
import { DriveStep, YouTubeStep } from './components/home/LinkSourceSteps';
import { JoinError, JoinStep, checkRoom } from './components/home/RoomSteps';
import { StatusTab } from './components/home/StatusTab';
import type { WatchIntent } from './components/catalog/CatalogTab';
import type { CommitMode, CommitOptions } from './components/home/types';
import { PRESETS } from './lib/media';
import { MediaPayload, SubtitleTrack } from './types/media';
import { logger } from './lib/logger';
import { discordManager, DiscordContextState } from './lib/discord';
import { syncManager } from './lib/sync';
import { generateRoomCode, roomCodeFrom } from './lib/roomCode';
import { RecentStream, loadRecentStreams, pushRecentStream, saveRecentStreams } from './lib/recent';

type HomeStep = 'menu' | 'join' | SourceStep;

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

function setRoomInUrl(code: string | null) {
  const url = new URL(window.location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  window.history.replaceState(null, '', url.pathname + url.search);
}

export default function App() {
  const [view, setView] = useState<'home' | 'player'>('home');
  const [homeTab, setHomeTab] = useState<HomeTab>('room');
  const [homeStep, setHomeStep] = useState<HomeStep>('menu');
  const [joinPrefill, setJoinPrefill] = useState<{ code: string; error: JoinError | null }>({ code: '', error: null });
  const [watchIntent, setWatchIntent] = useState<WatchIntent | null>(null);

  const [currentPayload, setCurrentPayload] = useState<MediaPayload>(EMPTY_PAYLOAD);
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
  const [isWatchPartyOpen, setIsWatchPartyOpen] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [kickBanAlert, setKickBanAlert] = useState<{ title: string; message: string; type: 'kicked' | 'banned' } | null>(null);

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
  const isWatchPartyOpenRef = useRef(isWatchPartyOpen);
  isWatchPartyOpenRef.current = isWatchPartyOpen;

  useEffect(() => {
    if (isWatchPartyOpen) setUnreadChatCount(0);
  }, [isWatchPartyOpen]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view, homeTab, homeStep]);

  const goHome = useCallback((tab: HomeTab = 'room', step: HomeStep = 'menu') => {
    setView('home');
    setHomeTab(tab);
    setHomeStep(step);
    // A intenção "assistir este título" vale só para o passo aberto pelo catálogo
    setWatchIntent(null);
    setIsWatchPartyOpen(false);
  }, []);

  const joinRoom = useCallback((code: string) => {
    setRoomInUrl(code);
    wasInRoomRef.current = false;
    syncManager.connect(code);
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

  /** Sai da sala de verdade: desconecta, limpa ?room=, descarrega o vídeo e volta para a tela inicial. */
  const leaveToHome = useCallback(() => {
    if (!discordManager.isDiscordActivity()) syncManager.leaveRoom();
    setRoomInUrl(null);
    setCurrentPayload(EMPTY_PAYLOAD);
    setPendingSubtitles([]);
    setUnreadChatCount(0);
    goHome('room');
  }, [goHome]);

  /** Entra numa sala, pedindo o apelido antes se for preciso. */
  const requestJoin = useCallback(
    (code: string) => {
      withName(
        () => joinRoom(code),
        'Entrar na sala',
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

    // No navegador: ?room=CODE entra direto na sala (ou mostra o erro na tela "Entrar na sala")
    if (!discordManager.isDiscordActivity()) {
      const queryRoom = new URLSearchParams(window.location.search).get('room');
      const validCode = queryRoom ? roomCodeFrom(queryRoom) : null;
      if (validCode) {
        checkRoom(validCode).then((info) => {
          if (info && !info.exists) {
            setRoomInUrl(null);
            setJoinPrefill({ code: validCode, error: info.closed ? 'closed' : 'not_found' });
            setHomeTab('room');
            setHomeStep('join');
            setView('home');
          } else {
            requestJoin(validCode);
          }
        });
      }
    }

    const unsubSync = syncManager.subscribeState(() => {
      setSyncStatus(syncManager.getStatus());
      const room = syncManager.getRoomState();
      if (room) wasInRoomRef.current = true;
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
        });
      }
    });

    const unsubMedia = syncManager.subscribeMedia((media, _generation, _triggeredBy, username) => {
      if (media && !syncManager.isRoomHost()) {
        setCurrentPayload({
          url: media.url,
          title: media.title,
          mimeType: 'video/x-matroska',
          chapters: media.chapters || [],
          subtitles: media.subtitles || [],
          audioTracks: media.audioTracks || [],
        });
      }
    });

    const unsubChat = syncManager.subscribeChat((msg) => {
      if (msg.isSystem) return;
      if (msg.userId === syncManager.getUser().id) return;
      if (!isWatchPartyOpenRef.current) setUnreadChatCount((c) => c + 1);
    });

    const unsubError = syncManager.subscribeError((_errorMsg, code) => {
      const kickedFromInside = wasInRoomRef.current;
      wasInRoomRef.current = false;
      if (code === 'banned' || code === 'kicked') {
        setRoomInUrl(null);
        setCurrentPayload(EMPTY_PAYLOAD);
        setPendingSubtitles([]);
        setIsWatchPartyOpen(false);
        setView('home');
        setHomeTab('room');
        setHomeStep('menu');
      }
      if (code === 'banned') {
        setKickBanAlert(
          kickedFromInside
            ? {
                title: 'Você foi banido da sala',
                message: 'O Host desta sala baniu você permanentemente. Você voltou para a tela inicial.',
                type: 'banned',
              }
            : {
                title: 'Você está banido desta sala',
                message: 'O Host desta sala baniu você, então não dá pra entrar nela de novo.',
                type: 'banned',
              }
        );
      } else if (code === 'kicked') {
        setKickBanAlert({
          title: 'Você foi expulso da sala',
          message: 'O Host removeu você da sala. Você voltou para a tela inicial.',
          type: 'kicked',
        });
      }
    });

    return () => {
      unsubDiscord();
      unsubSync();
      unsubMedia();
      unsubChat();
      unsubError();
    };
  }, []);

  /** Garante uma sala em que você é o Host e devolve o código. */
  const ensureRoom = useCallback((): string => {
    const st = syncManager.getStatus();
    if (discordManager.isDiscordActivity() && st.roomId) return st.roomId;
    if ((st.isConnected || st.isConnecting) && st.isHost && st.roomId) return st.roomId;
    if (st.isConnected || st.isConnecting) syncManager.leaveRoom();
    const code = generateRoomCode();
    setRoomInUrl(code);
    wasInRoomRef.current = false;
    syncManager.connect(code);
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
    });
  };

  /** Já é Host de uma sala aberta (trocar o vídeo não pede apelido de novo). */
  const isHostingRoom = () => {
    const st = syncManager.getStatus();
    return (st.isConnected || st.isConnecting) && st.isHost && Boolean(st.roomId);
  };

  const commitMedia = (payload: MediaPayload, mode: CommitMode, options: CommitOptions = {}, named = false) => {
    if (mode === 'room' && !named && !isHostingRoom()) {
      withName(() => commitMedia(payload, mode, options, true), 'Criar sala');
      return;
    }
    const merged: MediaPayload = { ...payload, subtitles: [...(payload.subtitles || []), ...pendingSubtitles] };
    setPendingSubtitles([]);
    setCurrentPayload(merged);
    setWatchIntent(null);
    if (options.recent) setRecentStreams((prev) => pushRecentStream(prev, merged.url, merged.title || ''));
    logger.info(`[Mídia] Abrindo "${merged.title}"`, { url: merged.url });

    if (mode === 'room') {
      // Cria a sala e já abre o player; o código fica no cabeçalho do player para compartilhar
      ensureRoom();
      emitCurrentMedia(merged);
      setView('player');
    } else {
      const st = syncManager.getStatus();
      if ((st.isConnected || st.isConnecting) && !discordManager.isDiscordActivity()) {
        syncManager.leaveRoom();
        setRoomInUrl(null);
      }
      setView('player');
    }
  };

  const handleSelectPreset = (presetId: string) => {
    const found = PRESETS.find((p) => p.id === presetId);
    if (!found) return;
    setCurrentPayload(found.payload);
    if (syncManager.isRoomHost()) emitCurrentMedia({ ...found.payload, title: found.payload.title || found.name });
    logger.info(`[Mídia] Abrindo o exemplo ${found.name}`);
  };

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

  const handleSoloMode = () => {
    setShowRoomModal(false);
    setRoomInUrl(null);
    syncManager.leaveRoom();
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

  const backToMenu = () => {
    setHomeStep('menu');
    setWatchIntent(null);
  };

  const renderRoomTab = () => {
    switch (homeStep) {
      case 'join':
        return (
          <JoinStep
            initialCode={joinPrefill.code}
            initialError={joinPrefill.error}
            onBack={backToMenu}
            onJoin={requestJoin}
            onCreate={backToMenu}
          />
        );
      case 'stream':
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
            preferSolo={watchIntent?.preferSolo}
            pendingSubtitles={pendingSubtitles.length}
            onAddSubtitle={() => setSubtitleModal('pending')}
            onBack={() => (watchIntent ? goHome('catalog') : backToMenu())}
            onCommit={commitMedia}
          />
        );
      case 'upload':
        return <UploadStep onBack={backToMenu} onCommit={commitMedia} ensureRoom={ensureRoom} requireName={(cb) => (isHostingRoom() ? cb() : withName(cb, 'Criar sala'))} onPickSource={setHomeStep} />;
      case 'youtube':
        return <YouTubeStep onBack={backToMenu} onCommit={commitMedia} />;
      case 'drive':
        return <DriveStep onBack={backToMenu} onCommit={commitMedia} />;
      default:
        return (
          <RoomMenu
            onPick={(step) => {
              setWatchIntent(null);
              setHomeStep(step);
            }}
            onJoin={() => {
              setJoinPrefill({ code: '', error: null });
              setHomeStep('join');
            }}
            onCatalog={() => setHomeTab('catalog')}
          />
        );
    }
  };

  return (
    <>
      {view === 'home' ? (
        <HomeLayout
          tab={homeTab}
          onTabChange={(tab) => {
            setHomeTab(tab);
            setWatchIntent(null);
            if (tab !== 'room') setHomeStep('menu');
          }}
          onLogo={() => goHome('room')}
          centered={homeTab !== 'catalog'}
        >
          {homeTab === 'catalog' ? (
            <Suspense fallback={<PanelFallback />}>
              <CatalogTab
                onWatch={(intent) => {
                  setWatchIntent(intent);
                  setHomeTab('room');
                  setHomeStep('stream');
                }}
                onCreateRoom={() => goHome('room')}
              />
            </Suspense>
          ) : homeTab === 'status' ? (
            <StatusTab environment={environment} room={roomInfo} />
          ) : (
            renderRoomTab()
          )}
        </HomeLayout>
      ) : (
        <PlayerPage
          onHome={leaveToHome}
          room={roomInfo}
          environment={environment}
          unreadChat={unreadChatCount}
          onToggleWatchParty={() => setIsWatchPartyOpen((v) => !v)}
          console={<PlayerConsole />}
        >
          <Suspense fallback={<PanelFallback />}>
            <VideoPlayer
              source={{ src: currentPayload.url, type: currentPayload.mimeType }}
              title={currentPayload.title}
              chapters={currentPayload.chapters}
              subtitles={currentPayload.subtitles}
              audioTracks={currentPayload.audioTracks}
              onResetToWorkingPreset={() => handleSelectPreset('sintel-local')}
              onOpenRoomLobby={() => setShowRoomModal(true)}
              isWatchPartyOpen={isWatchPartyOpen}
              onToggleWatchParty={() => setIsWatchPartyOpen((prev) => !prev)}
              onCloseWatchParty={() => setIsWatchPartyOpen(false)}
              onBack={leaveToHome}
              onLeaveRoom={leaveToHome}
              onAddSubtitle={() => setSubtitleModal('current')}
              onChooseVideo={() => goHome('room')}
              onMediaChangeRequested={(media) => {
                setCurrentPayload({
                  url: media.url,
                  title: media.title,
                  mimeType: 'video/x-matroska',
                  chapters: media.chapters || [],
                  subtitles: media.subtitles || [],
                  audioTracks: media.audioTracks || [],
                });
              }}
            />
          </Suspense>
        </PlayerPage>
      )}

      <SubtitleModal open={subtitleModal !== null} onClose={() => setSubtitleModal(null)} onAdd={addSubtitle} />

      <RoomLobbyModal
        isOpen={showRoomModal}
        onClose={() => setShowRoomModal(false)}
        onJoinRoom={handleJoinRoomFromLobby}
        onCreateRoom={handleCreateRoom}
        onSoloMode={handleSoloMode}
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

      {/* Aviso · Expulso / Banido */}
      <Modal open={kickBanAlert !== null} onClose={() => setKickBanAlert(null)} label={kickBanAlert?.title || ''} width={400} alert className="items-center text-center !gap-4">
        <div className="w-14 h-14 rounded-full bg-lu-error/12 border border-lu-error/30 flex items-center justify-center text-lu-error">
          {kickBanAlert?.type === 'banned' ? <Ban size={26} /> : <UserX size={26} />}
        </div>
        <div>
          <h2 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">{kickBanAlert?.title}</h2>
          <p className="mt-2 mb-0 text-[14px] text-lu-muted">{kickBanAlert?.message}</p>
        </div>
        <PrimaryButton size="lg" block className="mt-1" onClick={() => setKickBanAlert(null)}>
          Entendido
        </PrimaryButton>
      </Modal>
    </>
  );
}
