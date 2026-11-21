import type { SubtitlePreparationStatus } from '../types/media';
import { apiFetch } from './access';

/** Observes an existing shared job; stopping this observer never cancels that job. */
export function observeSubtitlePreparation(
  url: string,
  onStatus: (status: SubtitlePreparationStatus) => void,
  signal: AbortSignal,
): () => void {
  if (!url.startsWith('/api/subtitle?') || signal.aborted) return () => {};
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
    signal.removeEventListener('abort', stop);
  };
  signal.addEventListener('abort', stop, { once: true });
  const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  params.set('status', '1');
  const poll = async () => {
    try {
      const response = await apiFetch(`/api/subtitle?${params}`, { signal: controller.signal });
      if (response.ok) {
        const status = await response.json();
        // Content availability cannot declare the browser renderer ready.
        if (!stopped && ['queued', 'extracting', 'waiting_cdn', 'converting'].includes(status.stage) && Number.isFinite(status.updatedAt)) {
          onStatus({ stage: status.stage, updatedAt: status.updatedAt, ...(Number.isFinite(status.retryAt) ? { retryAt: status.retryAt } : {}) });
        }
      }
    } catch { /* Observation is optional; the content request owns error handling. */ }
    if (!stopped) timer = setTimeout(poll, 1000);
  };
  void poll();
  return stop;
}
