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

export async function createScreenPublisher(events: PublisherEvents): Promise<ScreenPublisher> {
  const [{ ScreenPublisher: Publisher }, { moqTransport }, { browserPublisher }] = await Promise.all([
    import('./publisher'),
    import('./moqTransport'),
    import('./publisherBrowser'),
  ]);
  return new Publisher({ transport: moqTransport(), browser: browserPublisher() }, events);
}

export async function createScreenViewer(events: ViewerEvents): Promise<ScreenViewer> {
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
