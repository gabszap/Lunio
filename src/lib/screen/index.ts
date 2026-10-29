/**
 * API pública da transmissão de tela no cliente. Os motores (e o `@moq/net`) só são baixados quando alguém vai
 * transmitir ou assistir: quem importa daqui não paga o peso deles no carregamento da página.
 */
export { screenCapabilities, type ScreenCapabilities } from './capabilities';
export type { PublisherEvents, PublisherStats, ScreenPublisher } from './publisher';
export type { ScreenViewer, ViewerEvents, ViewerStats } from './viewer';
export { generateScreenKey, type ScreenKeyMaterial } from './wire';

import type { PublisherEvents, ScreenPublisher } from './publisher';
import type { ScreenViewer, ViewerEvents } from './viewer';

/**
 * Costura de teste: o E2E troca o motor inteiro (captura, codecs e relay) por falsos, porque o Chromium do CI não
 * codifica H.264 e não há relay. Só vale se uma página definir `globalThis.__LUNIO_SCREEN_ENGINE__`; sem isso nada muda.
 */
export interface ScreenEngineOverride {
  createPublisher?: (events: PublisherEvents) => Promise<ScreenPublisher>;
  createViewer?: (events: ViewerEvents) => Promise<ScreenViewer>;
}

function engineOverride(): ScreenEngineOverride | null {
  const o = (globalThis as { __LUNIO_SCREEN_ENGINE__?: unknown }).__LUNIO_SCREEN_ENGINE__;
  return o && typeof o === 'object' ? (o as ScreenEngineOverride) : null;
}

export async function createScreenPublisher(events: PublisherEvents): Promise<ScreenPublisher> {
  const injected = engineOverride()?.createPublisher;
  if (typeof injected === 'function') return injected(events);
  const [{ ScreenPublisher: Publisher }, { moqTransport }, { browserPublisher }] = await Promise.all([
    import('./publisher'),
    import('./moqTransport'),
    import('./publisherBrowser'),
  ]);
  return new Publisher({ transport: moqTransport(), browser: browserPublisher() }, events);
}

export async function createScreenViewer(events: ViewerEvents): Promise<ScreenViewer> {
  const injected = engineOverride()?.createViewer;
  if (typeof injected === 'function') return injected(events);
  const [{ ScreenViewer: Viewer }, { moqTransport }] = await Promise.all([import('./viewer'), import('./moqTransport')]);
  return new Viewer({ transport: moqTransport() }, events);
}

/**
 * Baixa o motor antes de ele ser preciso (o menu do Host abriu, ou uma transmissão começou): o seletor de tela só abre
 * dentro de ~5 s do clique, então o download não pode ficar no caminho dele.
 */
export function preloadScreenEngine(): Promise<unknown> {
  return Promise.allSettled([import('./publisher'), import('./viewer'), import('./moqTransport'), import('./publisherBrowser'), import('@moq/net')]);
}
