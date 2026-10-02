import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOnline, watchOnline } from './network';

describe('réseau (A-09)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('isOnline lit navigator.onLine', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(isOnline()).toBe(false);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    expect(isOnline()).toBe(true);
  });

  it('watchOnline notifie les événements offline et online, puis s’arrête', () => {
    const listener = vi.fn();
    const stop = watchOnline(listener);
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(listener.mock.calls).toEqual([[false], [true]]);
    stop();
    window.dispatchEvent(new Event('offline'));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
