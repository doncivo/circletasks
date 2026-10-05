import { afterEach, describe, expect, it, vi } from 'vitest';
import { chronoAbsoluteParser } from '../../domain/chronoAbsolute';
import { naturalDate, type NaturalNow } from '../../domain/naturalDate';
import type { LocalDate, LocalTime } from '../../domain/types';
import { createAbsoluteDatesLoader, preloadAbsoluteDates } from './absoluteDatesLoader';

/** PERF-02 : chrono-node est chargé à la demande ; un échec garde la grammaire locale, est journalisé et permet un nouvel essai. */
const NOW: NaturalNow = { date: '2026-10-05' as LocalDate, time: '10:00' as LocalTime };
const ok = () => Promise.resolve({ chronoAbsoluteParser });

describe('chargeur de l’analyseur des dates écrites', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sans analyseur, la grammaire locale lit « demain 14h » mais pas « le 12 octobre » ; avec, les deux', () => {
    expect(naturalDate('rdv demain 14h', NOW, { absoluteDates: null })?.date).toBe('2026-10-06');
    expect(naturalDate('rdv le 12 octobre', NOW, { absoluteDates: null })).toBeNull();
    expect(naturalDate('rdv le 12 octobre', NOW, { absoluteDates: chronoAbsoluteParser })?.date).toBe('2026-10-12');
  });

  it('un chargement à la fois ; les abonnés sont prévenus à l’arrivée', async () => {
    const importer = vi.fn(ok);
    const loader = createAbsoluteDatesLoader(importer);
    const listener = vi.fn();
    loader.subscribe(listener);
    expect(loader.get()).toBeNull();
    const [a, b] = await Promise.all([loader.load(), loader.load()]);
    expect(a).toBe(chronoAbsoluteParser);
    expect(b).toBe(chronoAbsoluteParser);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(loader.get()).toBe(chronoAbsoluteParser);
    await loader.load();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('un échec : null sans exception, journalisé, grammaire locale gardée, nouvel essai possible', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    const loader = createAbsoluteDatesLoader(() => (++calls === 1 ? Promise.reject(new Error('bloc illisible')) : ok()));
    await expect(loader.load()).resolves.toBeNull();
    expect(loader.get()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[desktop:absolute-dates] bloc illisible'));
    expect(naturalDate('demain 9h', NOW, { absoluteDates: loader.get() })?.date).toBe('2026-10-06');
    await expect(loader.load()).resolves.toBe(chronoAbsoluteParser);
    expect(calls).toBe(2);
  });
});

describe('préchargement au repos de l’analyseur', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'requestIdleCallback');
    Reflect.deleteProperty(window, 'cancelIdleCallback');
    vi.useRealTimers();
  });

  it('avec requestIdleCallback : planifié avec un délai maximal, annulable', () => {
    const request = vi.fn((_cb: () => void, _options?: { timeout: number }) => 42);
    const cancel = vi.fn();
    Object.assign(window, { requestIdleCallback: request, cancelIdleCallback: cancel });
    const stop = preloadAbsoluteDates();
    expect(request).toHaveBeenCalledWith(expect.any(Function), { timeout: 1500 });
    stop();
    expect(cancel).toHaveBeenCalledWith(42);
  });

  it('sans requestIdleCallback (WebKit) : repli sur un minuteur de 100 ms, annulable', () => {
    vi.useFakeTimers();
    const stop = preloadAbsoluteDates();
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    preloadAbsoluteDates();
    vi.advanceTimersByTime(100);
    expect(vi.getTimerCount()).toBe(0);
  });
});
