import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** WebSocket falso: o teste decide quando abre e quando cai. */
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static last: FakeWebSocket;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor() {
    FakeWebSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', { parent: undefined, location: { protocol: 'https:', host: 'lunio.test', hostname: 'lunio.test', search: '' }, addEventListener: () => {}, removeEventListener: () => {} });
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('aviso de reconexão', () => {
  it('só marca "reconectando" quando a conexão com a sala cai; kick/ban e sair não', async () => {
    const { syncManager } = await import('./sync');
    expect(syncManager.getStatus().reconnecting).toBe(false);

    syncManager.connect('SALA');
    FakeWebSocket.last.open();
    expect(syncManager.getStatus().reconnecting).toBe(false);

    FakeWebSocket.last.drop(); // restart do servidor
    expect(syncManager.getStatus().reconnecting).toBe(true);

    vi.advanceTimersByTime(2000); // tentativa seguinte
    FakeWebSocket.last.open();
    expect(syncManager.getStatus().reconnecting).toBe(false);

    FakeWebSocket.last.drop(4002); // banido: não tenta voltar
    expect(syncManager.getStatus().reconnecting).toBe(false);
  });
});
