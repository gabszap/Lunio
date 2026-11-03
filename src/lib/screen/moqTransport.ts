import type { PublishHandle, ScreenTransport, TrackSink, TrackSource, WatchHandle } from './transport';

/** Prioridade de entrega no relay: o áudio vence o vídeo quando a rede aperta. */
const PRIORITY = { video: 60, audio: 80 } as const;
const POLL_MS = 50;
const CONNECT_TIMEOUT_MS = 15_000;

const aborted = () => new Error('Cancelado.');

/** Espera `get()` devolver algo (sondagem de 50 ms, como na spike), com prazo e cancelamento opcionais. */
async function until<T>(get: () => T | undefined, opts: { signal?: AbortSignal; timeoutMs?: number; timeoutMessage?: string } = {}): Promise<T> {
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
  for (;;) {
    if (opts.signal?.aborted) throw aborted();
    const v = get();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(opts.timeoutMessage ?? 'Tempo esgotado.');
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * A `Connection` do `@moq/net` é um pool que reconecta sozinho e já expõe `origin` antes de conectar: só o `status`
 * diz se o relay aceitou (token recusado ou relay fora do ar ficam em `connecting`/`disconnected`).
 */
export async function waitUntilConnected(
  status: { peek(): string },
  error: { peek(): Error | undefined },
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  await until(() => (status.peek() === 'connected' ? true : undefined), {
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? CONNECT_TIMEOUT_MS,
    // Só a frase genérica: a mensagem do erro do transporte pode trazer a URL com o token
    timeoutMessage: error.peek() ? 'O servidor de transmissão recusou a conexão.' : 'Não foi possível conectar ao servidor de transmissão.',
  });
}

/**
 * Transporte sobre o `@moq/net` (relay gerenciado da Cloudflare, WebTransport). O pacote é carregado só quando uma
 * transmissão é usada. Nunca registra a URL (leva o token) nem o caminho da transmissão.
 */
export function moqTransport(): ScreenTransport {
  const connect = async (url: string, signal?: AbortSignal) => {
    const Moq = await import('@moq/net');
    const conn = new Moq.Connection({ url: new URL(url), enabled: true });
    try {
      await waitUntilConnected(conn.status, conn.error, { signal });
      const origin = await until(() => conn.origin.peek(), { signal, timeoutMs: CONNECT_TIMEOUT_MS });
      return { Moq, conn, origin };
    } catch (e) {
      conn.close();
      throw e;
    }
  };

  return {
    async publish(url, pathName): Promise<PublishHandle> {
      const { Moq, conn, origin } = await connect(url);
      const broadcast = origin.createBroadcast(Moq.Path.from(pathName));
      const tracks = {
        video: broadcast.createTrack('video', { priority: PRIORITY.video }),
        audio: broadcast.createTrack('audio', { priority: PRIORITY.audio }),
      };
      broadcast.announce();

      const sink = (track: typeof tracks.video): TrackSink => {
        let group: ReturnType<typeof track.appendGroup> | undefined;
        return {
          write(payload, timestampUs, newGroup) {
            if (newGroup || !group) {
              group?.close();
              group = track.appendGroup();
            }
            group.writeFrame({ payload, timestamp: Moq.Time.Timestamp.fromMicros(timestampUs) });
          },
          close() {
            group?.close();
            group = undefined;
          },
        };
      };
      const sinks = { video: sink(tracks.video), audio: sink(tracks.audio) };

      return {
        ...sinks,
        hasSubscribers: () => Boolean(tracks.video.used.peek() || tracks.audio.used.peek()),
        close() {
          sinks.video.close();
          sinks.audio.close();
          try {
            broadcast.close();
          } finally {
            conn.close();
          }
        },
      };
    },

    async watch(url, pathName, signal): Promise<WatchHandle> {
      const { Moq, conn, origin } = await connect(url, signal);
      const request = origin.request(Moq.Path.from(pathName));
      let broadcast;
      try {
        broadcast = await until(() => request.active.peek(), { signal });
      } catch (e) {
        request.close();
        conn.close();
        throw e;
      }
      const sources: TrackSource[] = [];
      return {
        track(kind): TrackSource {
          const sub = broadcast.track(kind).subscribe();
          let closed = false;
          const source: TrackSource = {
            async *frames() {
              for (;;) {
                const group = await sub.recvGroup();
                if (!group || closed) return;
                for (;;) {
                  const frame = await group.readFrame();
                  if (!frame || closed) break;
                  yield frame.payload;
                }
                if (closed) return;
              }
            },
            close() {
              if (closed) return;
              closed = true;
              sub.close();
            },
          };
          sources.push(source);
          return source;
        },
        close() {
          for (const s of sources) s.close();
          request.close();
          conn.close();
        },
      };
    },
  };
}
