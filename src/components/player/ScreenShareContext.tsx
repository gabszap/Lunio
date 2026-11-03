import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SCREEN_QUALITY, screenQuality, type RoomScreen, type ScreenQuality, type ScreenQualityId } from '../../types/screen';
import { discordManager } from '../../lib/discord';
import { syncManager } from '../../lib/sync';
import { screenApi } from '../../lib/screen/api';
import { isOwnOrphan, screenAvailability } from '../../lib/screen/availability';
import { screenCancelledText } from '../../lib/screen/errors';
import { t } from '../../lib/i18n';
import { HostScreenSession, type HostScreenStatus } from '../../lib/screen/hostSession';
import { createScreenPublisher, createScreenViewer, preloadScreenEngine, screenCapabilities } from '../../lib/screen';
import { ViewerScreenSession, type ViewerScreenStatus } from '../../lib/screen/viewerSession';

const QUALITY_KEY = 'lunio_screen_quality';
const VOLUME_KEY = 'lunio_screen_volume';
const ENDED_NOTICE_MS = 4000;

/** O que o Host vê do que está saindo: fps codificados, Mbps do último segundo e o tamanho real da captura. */
export interface HostLiveStats {
  fps: number;
  mbps: number;
  width: number;
  height: number;
}

export interface ScreenShareValue {
  /** O botão "Transmitir a tela" deve aparecer (Host, sala, navegador capaz, servidor com a flag ligada). */
  canBroadcast: boolean;
  /** Este navegador sabe assistir a uma transmissão. */
  canWatch: boolean;
  screen: RoomScreen | null;
  isBroadcaster: boolean;
  host: { status: HostScreenStatus; error: string | null; notice: string | null; stats: HostLiveStats | null; preview: MediaStream | null };
  /** Quem está assistindo agora (o servidor só informa o Host que transmite). */
  viewers: Array<{ id: string; username: string }>;
  /** Volume (0 a 1) e mudo da transmissão para quem assiste: independentes do vídeo da sala. */
  volume: number;
  muted: boolean;
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
  /** Fecha o aviso de erro da transmissão (do Host e do espectador). */
  dismissError(): void;
  /** Ajusta o volume da transmissão (mexer no controle tira do mudo). */
  setVolume(v: number): void;
  toggleMuted(): void;
  /** "Trocar a tela" sem parar a transmissão. */
  switchScreen(): Promise<void>;
  /** O `<canvas>` do palco registra-se aqui; sobrevive à troca do `VideoPlayer` (que é remontado a cada vídeo). */
  attachCanvas(el: HTMLCanvasElement | null): void;
}

const INERT: ScreenShareValue = {
  canBroadcast: false,
  canWatch: false,
  screen: null,
  isBroadcaster: false,
  host: { status: 'idle', error: null, notice: null, stats: null, preview: null },
  viewers: [],
  volume: 1,
  muted: false,
  viewer: { status: 'idle', error: null },
  covering: false,
  endedNotice: false,
  lastQuality: DEFAULT_SCREEN_QUALITY,
  startBroadcast: async () => {},
  stopBroadcast: () => {},
  watch: () => {},
  returnToVideo: () => {},
  dismissError: () => {},
  setVolume: () => {},
  toggleMuted: () => {},
  switchScreen: async () => {},
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

function readVolume(): { volume: number; muted: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? 'null');
    if (saved && typeof saved.v === 'number' && saved.v >= 0 && saved.v <= 1) return { volume: saved.v, muted: saved.m === true };
  } catch {}
  return { volume: 1, muted: false };
}

/**
 * Dono das sessões de transmissão. Fica acima do `VideoPlayer` porque ele é remontado a cada vídeo novo (a fila, o
 * Host trocando): a transmissão não pode morrer junto.
 */
export const ScreenShareProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const discord = useMemo(() => discordManager.getState().isEmbedded, []);
  const capabilities = useMemo(() => (discord ? { host: false, viewer: false } : screenCapabilities()), [discord]);

  const [connected, setConnected] = useState(() => syncManager.getStatus().isConnected);
  /** Está numa sala (mesmo que a conexão tenha caído e esteja voltando): quem assiste não é derrubado por uma queda curta. */
  const [inRoom, setInRoom] = useState(() => Boolean(syncManager.getStatus().roomId));
  const [isHost, setIsHost] = useState(() => syncManager.getStatus().isHost);
  const [screen, setScreen] = useState<RoomScreen | null>(() => syncManager.getScreen());
  const [enabled, setEnabled] = useState(false);
  const [hostStatus, setHostStatus] = useState<HostScreenStatus>('idle');
  const [hostError, setHostError] = useState<string | null>(null);
  const [hostNotice, setHostNotice] = useState<string | null>(null);
  const [hostStats, setHostStats] = useState<HostLiveStats | null>(null);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [viewers, setViewers] = useState(() => syncManager.getScreenViewers());
  const [{ volume, muted }, setVol] = useState(readVolume);
  const [viewerStatus, setViewerStatus] = useState<ViewerScreenStatus>('idle');
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [endedNotice, setEndedNotice] = useState(false);
  const [lastQuality, setLastQuality] = useState<ScreenQualityId>(readLastQuality);

  const hostRef = useRef<HostScreenSession | null>(null);
  const viewerRef = useRef<ViewerScreenSession | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const volumeRef = useRef(readVolume());
  const orphanStoppedFor = useRef<string | null>(null);

  useEffect(
    () =>
      syncManager.subscribeState(() => {
        const st = syncManager.getStatus();
        setConnected(st.isConnected);
        setInRoom(Boolean(st.roomId));
        setIsHost(st.isHost);
        setScreen(syncManager.getScreen());
      }),
    []
  );

  useEffect(() => syncManager.subscribeScreenViewers(setViewers), []);

  const me = syncManager.getUserId();
  const isBroadcaster = Boolean(screen && screen.hostId === me);
  const { canBroadcast } = screenAvailability({ discord, capabilities, enabled, isHost, connected });

  // Só o Host precisa saber se o servidor liga a transmissão (o espectador só vê o que chega pela sala)
  useEffect(() => {
    if (!connected || !isHost || !capabilities.host) return;
    let alive = true;
    const check = () => void screenApi.isEnabled().then((v) => alive && setEnabled(v));
    check();
    // Uma consulta que falhou (rede, limite do /api/status) não pode esconder o botão para sempre: tenta de novo enquanto estiver "desligado"
    const retry = enabled ? null : setInterval(check, 20_000);
    return () => {
      alive = false;
      if (retry) clearInterval(retry);
    };
  }, [connected, isHost, capabilities.host, enabled]);

  // Baixa o motor assim que a pessoa pode transmitir (ou que há uma transmissão para assistir): o seletor de tela tem pouco tempo depois do clique
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

  // Números do que está saindo (fps, Mbps) e a prévia: lidos do publicador uma vez por segundo enquanto transmite
  useEffect(() => {
    if (hostStatus !== 'live') {
      setHostStats(null);
      setPreview(null);
      return;
    }
    let lastBytes = hostRef.current?.stats?.bytesOut ?? 0;
    const tick = () => {
      const host = hostRef.current;
      const s = host?.stats;
      if (!host || !s) return;
      const mbps = Math.round((Math.max(0, s.bytesOut - lastBytes) * 8) / 1e5) / 10;
      lastBytes = s.bytesOut;
      setHostStats((prev) =>
        prev && prev.fps === s.fps && prev.mbps === mbps && prev.width === s.width && prev.height === s.height
          ? prev
          : { fps: s.fps, mbps, width: s.width, height: s.height }
      );
      const pv = host.previewStream;
      setPreview((prev) => (prev === pv ? prev : pv));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [hostStatus]);

  // Aviso curto quando a transmissão acaba
  useEffect(() => {
    if (viewerStatus !== 'ended') {
      setEndedNotice(false); // o aviso é de uma transmissão que acabou: não sobrevive a outra tentativa nem a outra sala
      return;
    }
    setEndedNotice(true);
    const id = setTimeout(() => setEndedNotice(false), ENDED_NOTICE_MS);
    return () => clearTimeout(id);
  }, [viewerStatus]);

  const teardownHost = useCallback(() => {
    void hostRef.current?.stop();
    hostRef.current = null;
    setHostStatus('idle');
    setHostError(null);
    setHostNotice(null);
    setHostStats(null);
    setPreview(null);
  }, []);

  const teardownViewer = useCallback(() => {
    viewerRef.current?.dispose();
    viewerRef.current = null;
    setViewerStatus('idle');
    setViewerError(null);
    setEndedNotice(false);
  }, []);

  // O Host sem conexão com a sala deixa de transmitir (o servidor também encerra); quem assiste só sai ao deixar a sala,
  // porque a imagem vem do relay e uma queda curta do WebSocket não precisa interrompê-la
  useEffect(() => {
    if (!connected) teardownHost();
  }, [connected, teardownHost]);
  useEffect(() => {
    if (!inRoom) teardownViewer();
  }, [inRoom, teardownViewer]);
  useEffect(
    () => () => {
      teardownHost();
      teardownViewer();
    },
    [teardownHost, teardownViewer]
  );

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
      session.setVolume(volumeRef.current.muted ? 0 : volumeRef.current.volume);
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

  const dismissError = useCallback(() => {
    setHostError(null);
    setHostNotice(null);
    setViewerError(null);
    setViewerStatus((s) => (s === 'error' ? 'idle' : s));
  }, []);

  const applyVolume = useCallback((next: { volume: number; muted: boolean }) => {
    volumeRef.current = next;
    setVol(next);
    viewerRef.current?.setVolume(next.muted ? 0 : next.volume);
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify({ v: next.volume, m: next.muted }));
    } catch {}
  }, []);

  const setVolume = useCallback((v: number) => applyVolume({ volume: Math.min(1, Math.max(0, v)), muted: v <= 0 }), [applyVolume]);
  const toggleMuted = useCallback(() => applyVolume({ volume: volumeRef.current.volume || 1, muted: !volumeRef.current.muted }), [applyVolume]);

  const switchScreen = useCallback(async () => {
    const host = hostRef.current;
    if (!host) return;
    setHostError(null);
    try {
      await host.switchSource();
    } catch (e) {
      setHostError(e instanceof Error && e.message ? e.message : t('Não foi possível trocar a tela.'));
    }
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
      host: { status: hostStatus, error: hostError, notice: hostNotice, stats: hostStats, preview },
      viewers,
      volume,
      muted,
      viewer: { status: viewerStatus, error: viewerError },
      covering: viewerStatus === 'connecting' || viewerStatus === 'watching',
      endedNotice,
      lastQuality,
      startBroadcast,
      stopBroadcast,
      watch,
      returnToVideo,
      dismissError,
      setVolume,
      toggleMuted,
      switchScreen,
      attachCanvas,
    }),
    [canBroadcast, capabilities.viewer, screen, isBroadcaster, hostStatus, hostError, hostNotice, hostStats, preview, viewers, volume, muted, viewerStatus, viewerError, endedNotice, lastQuality, startBroadcast, stopBroadcast, watch, returnToVideo, dismissError, setVolume, toggleMuted, switchScreen, attachCanvas]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
