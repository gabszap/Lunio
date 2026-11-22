import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioBoostManager } from './audioBoost';

describe('AudioBoostManager', () => {
  let resumeMock: ReturnType<typeof vi.fn>;
  let setGainMock: ReturnType<typeof vi.fn>;
  let setDelayMock: ReturnType<typeof vi.fn>;
  let fakeCtxState: 'suspended' | 'running';

  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      clear: () => store.clear(),
    });
    fakeCtxState = 'suspended';
    resumeMock = vi.fn().mockImplementation(async () => {
      fakeCtxState = 'running';
    });
    setGainMock = vi.fn();
    setDelayMock = vi.fn();

    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      get state() {
        return fakeCtxState;
      }
      resume = resumeMock;
      suspend = vi.fn().mockResolvedValue(undefined);
      createMediaElementSource = vi.fn(() => ({ connect: vi.fn() }));
      createGain = vi.fn(() => ({
        connect: vi.fn(),
        gain: { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: setGainMock },
      }));
      createDelay = vi.fn(() => ({
        connect: vi.fn(),
        delayTime: { value: 0, cancelScheduledValues: vi.fn(), setValueAtTime: setDelayMock },
      }));
      createDynamicsCompressor = vi.fn(() => ({
        connect: vi.fn(),
        threshold: { setValueAtTime: vi.fn() },
        knee: { setValueAtTime: vi.fn() },
        ratio: { setValueAtTime: vi.fn() },
        attack: { setValueAtTime: vi.fn() },
        release: { setValueAtTime: vi.fn() },
      }));
    }

    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aplica volume boost e atraso de áudio e retoma AudioContext suspenso quando vídeo já está tocando', () => {
    const mgr = new AudioBoostManager();
    const fakeVideo = {
      paused: false,
      addEventListener: vi.fn(),
    } as unknown as HTMLMediaElement;

    mgr.attachToElement(fakeVideo);
    mgr.setBoost(175);
    expect(mgr.getBoost()).toBe(175);
    expect(setGainMock).toHaveBeenCalledWith(1.75, 0);
    expect(resumeMock).toHaveBeenCalled();

    mgr.setAudioDelay(0.25);
    expect(mgr.getAudioDelay()).toBe(0.25);
    expect(setDelayMock).toHaveBeenCalledWith(0.25, 0);
  });
});
