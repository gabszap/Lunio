import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SCREEN_QUALITY, screenQuality, type RoomScreen, type ScreenQuality, type ScreenQualityId } from '../../types/screen';
import { discordManager } from '../../lib/discord';
import { syncManager } from '../../lib/sync';
import { screenApi } from '../../lib/screen/api';
import { isOwnOrphan, screenAvailability } from '../../lib/screen/availability';
import { screenCancelledText } from '../../lib/screen/errors';
import { HostScreenSession, type HostScreenStatus } from '../../lib/screen/hostSession';
import { createScreenPublisher, createScreenViewer, preloadScreenEngine, screenCapabilities } from '../../lib/screen';
import { ViewerScreenSession, type ViewerScreenStatus } from '../../lib/screen/viewerSession';

const QUALITY_KEY = 'lunio_screen_quality';
const ENDED_NOTICE_MS = 4000;

export interface ScreenShareValue {
  /** O botão "Transmitir a tela" deve aparecer (Host, sala, navegador capaz, servidor com a flag ligada). */
  canBroadcast: boolean;
  /** Este navegador sabe assistir a uma transmissão. */
  canWatch: boolean;
  screen: RoomScreen | null;
  isBroadcaster: boolean;
  host: { status: HostScreenStatus; error: string | null; notice: string | null; hasSubscribers: boolean };
  viewer: { status: ViewerScreenStatus; error: string | null };
  /** O palco da transmissão cobre o vídeo da sala (conectando ou assistindo): o vídeo fica mudo e escondido por baixo. */
  covering: boolean;
  /** A transmissão acabou há pouco (aviso de alguns segundos). */
  endedNotice: boolean;
  lastQuality: ScreenQualityId;
  startBroadcast(q: ScreenQuality): Promise<void>;
  stopBroadcast(): void;
  watch(): void;
  returnToVideo(): void;
  /** Volume efetivo do player (0 se mudo): a transmissão segue o controle de volume do player. */
  setVolume(v: number): void;
  /** O `<canvas>` do palco registra-se aqui; sobrevive à troca do `VideoPlayer` (que é remontado a cada vídeo). */
  attachCanvas(el: HTMLCanvasElement | null): void;
}

const INERT: ScreenShareValue = {
  canBroadcast: false,
  canWatch: false,
  screen: null,
  isBroadcaster: false,
  host: { status: 'idle', error: null, notice: null, hasSubscribers: false },
  viewer: { status: 'idle', error: null },
  covering: false,
  endedNotice: false,
  lastQuality: DEFAULT_SCREEN_QUALITY,
  startBroadcast: async () => {},
  stopBroadcast: () => {},
  watch: () => {},
  returnToVideo: () => {},
  setVolume: () => {},
  attachCanvas: () => {},
};

const Ctx = createContext<ScreenShareValue>(INERT);

/** Fora do provider (testes, telas sem sala) a transmissão simplesmente não existe. */
export const useScreenShare = () => useContext(Ctx);

function readLastQuality(): ScreenQualityId {
  try {
    const saved = screenQuality(localStorage.getItem(QUALITY_KEY));
    if (saved) return saved.id;
  } catch {}
  return DEFAULT_SCREEN_QUALITY;
}

/**
 * Dono das sessões de transmissão. Fica acima do `VideoPlayer` porque ele é remontado a cada vídeo novo (a fila, o
 * Host trocando): a transmissão não pode morrer junto.
 */
export const ScreenShareProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const discord = useMemo(() => discordManager.getState().isEmbedded, []);
  const capabilities = useMemo(() => (discord ? { host: false, viewer: false } : screenCapabilities()), [discord]);

  const [connected, setConnected] = useState(() => syncManager.getStatus().isConnected);
  const [isHost, setIsHost] = useState(() => syncManager.getStatus().isHost);
  const [screen, setScreen] = useState<RoomScreen | null>(() => syncManager.getScreen());
  const [enabled, setEnabled] = useState(false);
  const [hostStatus, setHostStatus] = useState<HostScreenStatus>('idle');
  const [hostError, setHostError] = useState<string | null>(null);
  const [hostNotice, setHostNotice] = useState<string | null>(null);
  const [hasSubscribers, setHasSubscribers] = useState(false);
  const [viewerStatus, setViewerStatus] = useState<ViewerScreenStatus>('idle');
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [endedNotice, setEndedNotice] = useState(false);
  const [lastQuality, setLastQuality] = useState<ScreenQualityId>(readLastQuality);

  const hostRef = useRef<HostScreenSession | null>(null);
  const viewerRef = useRef<ViewerScreenSession | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const volumeRef = useRef(1);
  const orphanStoppedFor = useRef<string | null>(null);

  useEffect(
    () =>
      syncManager.subscribeState(() => {
        const st = syncManager.getStatus();
        setConnected(st.isConnected);
        setIsHost(st.isHost);
        setScreen(syncManager.getScreen());
      }),
    []
  );

  const me = syncManager.getUserId();
  const isBroadcaster = Boolean(screen && screen.hostId === me);
  const { canBroadcast } = screenAvailability({ discord, capabilities, enabled, isHost, connected });

  // Só o Host precisa saber se o servidor liga a transmissão (o espectador só vê o que chega pela sala)
  useEffect(() => {
    if (!connected || !isHost || !capabilities.host) return;
    let alive = true;
    void screenApi.isEnabled().then((v) => alive && setEnabled(v));
    return () => {
      alive = false;
    };
  }, [connected, isHost, capabilities.host]);

  // Baixa o motor antes de ele ser preciso: o seletor de tela tem pouco tempo depois do clique
  useEffect(() => {
    if (canBroadcast || (capabilities.viewer && screen?.live && !isBroadcaster)) void preloadScreenEngine();
  }, [canBroadcast, capabilities.viewer, screen?.live, isBroadcaster]);

  // Transmissão minha sem sessão nesta página (recarreguei): encerra, senão a sala fica "ao vivo" sem imagem
  useEffect(() => {
    if (!isOwnOrphan(screen, me, hostRef.current !== null)) return;
    if (orphanStoppedFor.current === screen!.sessionId) return;
    orphanStoppedFor.current = screen!.sessionId;
    syncManager.emitScreenStop();
  }, [screen, me]);

  // "Alguém assistindo" muda sem aviso: consulta de tempos em tempos enquanto transmite
  useEffect(() => {
    if (hostStatus !== 'live') {
      setHasSubscribers(false);
      return;
    }
    const id = setInterval(() => setHasSubscribers(hostRef.current?.hasSubscribers ?? false), 2000);
    return () => clearInterval(id);
  }, [hostStatus]);

  // Aviso curto quando a transmissão acaba
  useEffect(() => {
    if (viewerStatus !== 'ended') return;
    setEndedNotice(true);
    const id = setTimeout(() => setEndedNotice(false), ENDED_NOTICE_MS);
    return () => clearTimeout(id);
  }, [viewerStatus]);

  const teardown = useCallback(() => {
    void hostRef.current?.stop();
    hostRef.current = null;
    viewerRef.current?.dispose();
    viewerRef.current = null;
    setHostStatus('idle');
    setViewerStatus('idle');
  }, []);

  // Saiu da sala, foi expulso ou a conexão acabou: nada de sessão viva
  useEffect(() => {
    if (!connected) teardown();
  }, [connected, teardown]);
  useEffect(() => teardown, [teardown]);

  const startBroadcast = useCallback(async (q: ScreenQuality) => {
    if (hostRef.current) return;
    try {
      localStorage.setItem(QUALITY_KEY, q.id);
    } catch {}
    setLastQuality(q.id);
    setHostError(null);
    setHostNotice(null);
    const session = new HostScreenSession(
      { signals: syncManager, api: screenApi, createPublisher: createScreenPublisher },
      {
        onStatus: (status, detail) => {
          setHostStatus(status);
          setHostError(status === 'error' ? detail ?? null : null);
          if (status === 'idle' || status === 'error') {
            if (hostRef.current === session) hostRef.current = null;
          }
        },
      }
    );
    hostRef.current = session;
    try {
      if ((await session.start(q)) === 'cancelled') setHostNotice(screenCancelledText());
    } catch {
      // o motivo já chegou por onStatus('error', ...)
    }
  }, []);

  const stopBroadcast = useCallback(() => {
    void hostRef.current?.stop();
  }, []);

  const getViewer = useCallback(() => {
    if (!viewerRef.current) {
      const session = new ViewerScreenSession(
        { signals: syncManager, api: screenApi, createViewer: createScreenViewer },
        {
          onStatus: (status, detail) => {
            setViewerStatus(status);
            setViewerError(status === 'error' ? detail ?? null : null);
          },
        }
      );
      session.setVolume(volumeRef.current);
      viewerRef.current = session;
    }
    return viewerRef.current;
  }, []);

  const watch = useCallback(() => {
    const session = getViewer();
    if (canvasRef.current) session.attach(canvasRef.current);
    void session.watch();
  }, [getViewer]);

  const returnToVideo = useCallback(() => viewerRef.current?.returnToVideo(), []);

  const setVolume = useCallback((v: number) => {
    volumeRef.current = v;
    viewerRef.current?.setVolume(v);
  }, []);

  const attachCanvas = useCallback((el: HTMLCanvasElement | null) => {
    canvasRef.current = el;
    if (el) viewerRef.current?.attach(el);
  }, []);

  const value = useMemo<ScreenShareValue>(
    () => ({
      canBroadcast,
      canWatch: capabilities.viewer,
      screen,
      isBroadcaster,
      host: { status: hostStatus, error: hostError, notice: hostNotice, hasSubscribers },
      viewer: { status: viewerStatus, error: viewerError },
      covering: viewerStatus === 'connecting' || viewerStatus === 'watching',
      endedNotice,
      lastQuality,
      startBroadcast,
      stopBroadcast,
      watch,
      returnToVideo,
      setVolume,
      attachCanvas,
    }),
    [canBroadcast, capabilities.viewer, screen, isBroadcaster, hostStatus, hostError, hostNotice, hasSubscribers, viewerStatus, viewerError, endedNotice, lastQuality, startBroadcast, stopBroadcast, watch, returnToVideo, setVolume, attachCanvas]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
