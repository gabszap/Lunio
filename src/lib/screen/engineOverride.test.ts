import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScreenPublisher, createScreenViewer } from './index';
import { ScreenPublisher } from './publisher';
import { ScreenViewer } from './viewer';

const g = globalThis as { __LUNIO_SCREEN_ENGINE__?: unknown };

afterEach(() => {
  delete g.__LUNIO_SCREEN_ENGINE__;
});

describe('engine test seam', () => {
  it('uses the injected factories and hands them the events', async () => {
    const fakePublisher = { fake: 'publisher' };
    const fakeViewer = { fake: 'viewer' };
    const createPublisher = vi.fn(async () => fakePublisher);
    const createViewer = vi.fn(async () => fakeViewer);
    g.__LUNIO_SCREEN_ENGINE__ = { createPublisher, createViewer };

    const pubEvents = { onEnded: vi.fn(), onUsage: vi.fn() };
    const viewEvents = { onStatus: vi.fn() };
    expect(await createScreenPublisher(pubEvents)).toBe(fakePublisher);
    expect(await createScreenViewer(viewEvents)).toBe(fakeViewer);
    expect(createPublisher).toHaveBeenCalledWith(pubEvents);
    expect(createViewer).toHaveBeenCalledWith(viewEvents);
  });

  it('can replace only one of the two', async () => {
    const fakeViewer = { fake: 'viewer' };
    g.__LUNIO_SCREEN_ENGINE__ = { createViewer: async () => fakeViewer };
    expect(await createScreenViewer({ onStatus: vi.fn() })).toBe(fakeViewer);
    expect(await createScreenPublisher({ onEnded: vi.fn(), onUsage: vi.fn() })).toBeInstanceOf(ScreenPublisher);
  });

  it('without the global, or with anything that is not an object, the real engine is used', async () => {
    expect(await createScreenPublisher({ onEnded: vi.fn(), onUsage: vi.fn() })).toBeInstanceOf(ScreenPublisher);
    expect(await createScreenViewer({ onStatus: vi.fn() })).toBeInstanceOf(ScreenViewer);
    for (const junk of ['x', 42, null, true]) {
      g.__LUNIO_SCREEN_ENGINE__ = junk;
      expect(await createScreenPublisher({ onEnded: vi.fn(), onUsage: vi.fn() })).toBeInstanceOf(ScreenPublisher);
    }
  });

  it('a non-function entry is ignored', async () => {
    g.__LUNIO_SCREEN_ENGINE__ = { createPublisher: 'nope', createViewer: 7 };
    expect(await createScreenViewer({ onStatus: vi.fn() })).toBeInstanceOf(ScreenViewer);
  });
});
