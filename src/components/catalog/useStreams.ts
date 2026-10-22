import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoAddon } from '../../lib/addons';
import { fetchStreams, sortStreams, type SourceResult, type StreamOption, type StreamTarget } from '../../lib/streams';
import { detectBrowserSupport } from '../../lib/streamPlayability';

export interface StreamsState {
  status: 'idle' | 'loading' | 'done';
  options: StreamOption[];
  failedSources: number;
  dropped: number;
  pending: number;
}

const IDLE: StreamsState = { status: 'idle', options: [], failedSources: 0, dropped: 0, pending: 0 };

export function reduceStreams(state: StreamsState, result: SourceResult): StreamsState {
  const pending = Math.max(0, state.pending - 1);
  return {
    status: pending === 0 ? 'done' : 'loading',
    options: sortStreams([...state.options, ...result.options]),
    failedSources: state.failedSources + (result.failed ? 1 : 0),
    dropped: state.dropped + result.dropped,
    pending,
  };
}

/** Pede os streams ao trocar de alvo; o resultado de um alvo anterior nunca chega ao estado. */
export function useStreams(addons: VideoAddon[], target: StreamTarget | null): { state: StreamsState; retry: () => void } {
  const [state, setState] = useState<StreamsState>(IDLE);
  const [attempt, setAttempt] = useState(0);
  const addonsRef = useRef(addons);
  addonsRef.current = addons;
  const targetRef = useRef(target);
  targetRef.current = target;

  // Só o conjunto de addons e o alvo reiniciam o pedido, não a identidade dos objetos
  const addonsKey = addons.map((a) => a.id).join('|');
  const targetKey = target ? JSON.stringify(target) : '';

  useEffect(() => {
    const list = addonsRef.current;
    const current = targetRef.current;
    if (!current || list.length === 0) {
      setState(IDLE);
      return;
    }
    const ctrl = new AbortController();
    setState({ status: 'loading', options: [], failedSources: 0, dropped: 0, pending: list.length });
    (async () => {
      const support = await detectBrowserSupport();
      if (ctrl.signal.aborted) return;
      await fetchStreams(list, current, {
        support,
        signal: ctrl.signal,
        onSource: (r) => {
          if (!ctrl.signal.aborted) setState((s) => reduceStreams(s, r));
        },
      });
      // addon que não entende este id não responde: fecha a conta
      if (!ctrl.signal.aborted) setState((s) => (s.status === 'loading' ? { ...s, status: 'done', pending: 0 } : s));
    })();
    return () => ctrl.abort();
  }, [addonsKey, targetKey, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
