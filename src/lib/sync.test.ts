import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncManager } from './sync';

class FakeBrowserWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeBrowserWebSocket[] = [];

  readyState = FakeBrowserWebSocket.CONNECTING;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((err: any) => void) | null = null;

  constructor(public readonly url: string) {
    FakeBrowserWebSocket.instances.push(this);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = FakeBrowserWebSocket.CLOSED;
  }
  triggerOpen() {
    this.readyState = FakeBrowserWebSocket.OPEN;
    this.onopen?.();
  }
}

describe('SyncManager connect/joinRoom edge cases', () => {
  const origWs = globalThis.WebSocket;
  const origWindow = globalThis.window;

  beforeEach(() => {
    FakeBrowserWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeBrowserWebSocket);
    if (typeof window === 'undefined') {
      vi.stubGlobal('window', {
        location: { protocol: 'http:', host: 'localhost:3000', href: 'http://localhost:3000/', pathname: '/', search: '' },
        history: { replaceState: vi.fn() },
      });
    }
    syncManager.leaveRoom();
  });

  afterEach(() => {
    syncManager.leaveRoom();
    vi.stubGlobal('WebSocket', origWs);
    vi.stubGlobal('window', origWindow);
  });

  it('não entra em recursão infinita ao chamar connect/joinRoom enquanto o WebSocket está em CONNECTING', () => {
    syncManager.connect('ROOM1');
    expect(FakeBrowserWebSocket.instances).toHaveLength(1);
    const ws = FakeBrowserWebSocket.instances[0];
    expect(ws.readyState).toBe(FakeBrowserWebSocket.CONNECTING);

    // Antes do fix (C3), isso estourava Maximum call stack size exceeded
    expect(() => syncManager.connect('ROOM1', 'senha123')).not.toThrow();
    expect(() => syncManager.joinRoom('ROOM2', 'outra')).not.toThrow();
    expect(FakeBrowserWebSocket.instances).toHaveLength(1);

    ws.triggerOpen();
    expect(ws.sent[0]).toMatchObject({ type: 'room:join', roomId: 'ROOM2', password: 'outra' });
  });

  it('limpa a senha anterior ao trocar de sala sem nova senha e não envia heartbeat antes de room:state', () => {
    syncManager.connect('PRIV1', 'segredo');
    const ws = FakeBrowserWebSocket.instances[0];
    ws.triggerOpen();
    expect(ws.sent[0]).toMatchObject({ type: 'room:join', roomId: 'PRIV1', password: 'segredo' });
    // Sem room:state ainda -> nenhum client:heartbeat disparado
    expect(ws.sent.some((m) => m.type === 'client:heartbeat')).toBe(false);

    // Troca para outra sala sem informar senha -> não vaza 'segredo'
    syncManager.joinRoom('PUB2');
    const join2 = ws.sent.filter((m) => m.type === 'room:join').at(-1);
    expect(join2).toMatchObject({ type: 'room:join', roomId: 'PUB2' });
    expect(join2.password).toBeUndefined();
  });
});
