import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDelayedFlag } from './useDelayedFlag';

describe('useDelayedFlag (A-09 critère 1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ne devient vrai qu’après le délai', () => {
    const { result } = renderHook(({ active }) => useDelayedFlag(active, 150), { initialProps: { active: true } });
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(149));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(2));
    expect(result.current).toBe(true);
  });

  it('un chargement plus court que le délai ne déclenche rien (pas de clignotement)', () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 150), { initialProps: { active: true } });
    act(() => void vi.advanceTimersByTime(100));
    rerender({ active: false });
    act(() => void vi.advanceTimersByTime(500));
    expect(result.current).toBe(false);
  });

  it('retombe à faux dès que l’activité s’arrête', () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 150), { initialProps: { active: true } });
    act(() => void vi.advanceTimersByTime(200));
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });
});
