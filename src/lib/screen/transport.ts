/** Onde os quadros cifrados vão e de onde vêm: o relay MoQ em produção, a memória nos testes. */
export interface TrackSink {
  /** `newGroup`: este quadro abre um grupo novo (vídeo: quadro-chave; áudio: a cada 1 s de mídia). */
  write(payload: Uint8Array, timestampUs: number, newGroup: boolean): void;
  close(): void;
}

export interface TrackSource {
  /** Quadros na ordem em que chegam; termina quando a fonte ou o publicador fecham. */
  frames(): AsyncIterable<Uint8Array>;
  close(): void;
}

export interface PublishHandle {
  video: TrackSink;
  audio: TrackSink;
  /** Alguém está inscrito em alguma faixa agora? */
  hasSubscribers(): boolean;
  close(): void;
}

export interface WatchHandle {
  track(kind: 'video' | 'audio'): TrackSource;
  close(): void;
}

export interface ScreenTransport {
  publish(url: string, path: string): Promise<PublishHandle>;
  /** Espera a transmissão aparecer; rejeita se o sinal abortar. */
  watch(url: string, path: string, signal?: AbortSignal): Promise<WatchHandle>;
}

class Channel {
  groups: Uint8Array[][] = [];
  closed = false;
  subscribers = 0;
  private waiters = new Set<() => void>();

  write(payload: Uint8Array, newGroup: boolean): void {
    if (newGroup || this.groups.length === 0) this.groups.push([]);
    this.groups[this.groups.length - 1].push(payload);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  wake(): void {
    const all = [...this.waiters];
    this.waiters.clear();
    for (const w of all) w();
  }

  wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.add(resolve));
  }
}

interface Published {
  video: Channel;
  audio: Channel;
  closed: boolean;
}

/** Transporte em memória: um publicador por caminho, qualquer número de espectadores. Só para testes. */
export function memoryTransport(): ScreenTransport & { groups(path: string, kind: 'video' | 'audio'): number[][] } {
  const published = new Map<string, Published>();
  const arrivals = new Set<() => void>();

  const sink = (ch: Channel): TrackSink => ({
    write: (payload, _ts, newGroup) => ch.write(payload, newGroup),
    close: () => ch.close(),
  });

  const source = (ch: Channel): TrackSource => {
    let stopped = false;
    // Quem entra no meio começa no grupo mais recente, como numa transmissão ao vivo
    let g = Math.max(0, ch.groups.length - 1);
    let f = 0;
    ch.subscribers++;
    return {
      async *frames() {
        for (;;) {
          if (stopped) return;
          const group = ch.groups[g];
          if (group && f < group.length) {
            yield group[f++];
            continue;
          }
          if (group && g < ch.groups.length - 1) {
            g++;
            f = 0;
            continue;
          }
          if (ch.closed) return;
          await ch.wait();
        }
      },
      close() {
        if (stopped) return;
        stopped = true;
        ch.subscribers--;
        ch.wake();
      },
    };
  };

  return {
    async publish(_url, path) {
      const entry: Published = { video: new Channel(), audio: new Channel(), closed: false };
      published.set(path, entry);
      for (const a of [...arrivals]) a();
      return {
        video: sink(entry.video),
        audio: sink(entry.audio),
        hasSubscribers: () => entry.video.subscribers + entry.audio.subscribers > 0,
        close() {
          entry.closed = true;
          entry.video.close();
          entry.audio.close();
        },
      };
    },

    async watch(_url, path, signal) {
      const abort = () => new Error('Cancelado.');
      if (signal?.aborted) throw abort();
      while (!published.get(path) || published.get(path)!.closed) {
        await new Promise<void>((resolve, reject) => {
          const onArrival = () => {
            cleanup();
            resolve();
          };
          const onAbort = () => {
            cleanup();
            reject(abort());
          };
          const cleanup = () => {
            arrivals.delete(onArrival);
            signal?.removeEventListener('abort', onAbort);
          };
          arrivals.add(onArrival);
          signal?.addEventListener('abort', onAbort);
        });
      }
      const entry = published.get(path)!;
      const sources: TrackSource[] = [];
      return {
        track(kind) {
          const s = source(kind === 'video' ? entry.video : entry.audio);
          sources.push(s);
          return s;
        },
        close() {
          for (const s of sources) s.close();
        },
      };
    },

    groups(path, kind) {
      const entry = published.get(path);
      if (!entry) return [];
      return (kind === 'video' ? entry.video : entry.audio).groups.map((g) => g.map((p) => p.length));
    },
  };
}
