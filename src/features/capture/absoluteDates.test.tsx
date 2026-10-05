import { act, renderHook, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chronoAbsoluteParser } from '../../domain/chronoAbsolute';
import { hasAbsoluteDateParser, naturalDate, registerAbsoluteDateParser, type NaturalNow } from '../../domain/naturalDate';
import type { LocalDate, LocalTime } from '../../domain/types';
import { loadAbsoluteDates, useAbsoluteDates } from './absoluteDates';

/** PERF-02 : chrono-node est chargé à la demande ; une saisie faite avant la fin du chargement est relue ensuite (Q-02, Q-06). */
const NOW: NaturalNow = { date: '2026-10-05' as LocalDate, time: '10:00' as LocalTime };

describe('chargement à la demande des dates écrites', () => {
  beforeAll(() => registerAbsoluteDateParser(null));
  afterAll(() => registerAbsoluteDateParser(chronoAbsoluteParser));

  it('sans l’analyseur, la grammaire locale lit déjà demain et les heures, mais pas « le 12 octobre »', () => {
    expect(hasAbsoluteDateParser()).toBe(false);
    expect(naturalDate('rdv demain 14h', NOW)?.date).toBe('2026-10-06');
    expect(naturalDate('rdv le 12 octobre', NOW)).toBeNull();
  });

  it('le hook lance le chargement et change d’état à l’arrivée ; la même saisie est alors lue en entier', async () => {
    const { result } = renderHook(() => useAbsoluteDates());
    const before = result.current;
    await waitFor(() => expect(hasAbsoluteDateParser()).toBe(true));
    await waitFor(() => expect(result.current).not.toBe(before));
    expect(naturalDate('rdv le 12 octobre', NOW)?.date).toBe('2026-10-12');
    expect(naturalDate('dans 3 jours', NOW)?.date).toBe('2026-10-08');
  });

  it('un second appel ne recharge rien et se résout aussitôt', async () => {
    await act(async () => {
      await loadAbsoluteDates();
    });
    expect(hasAbsoluteDateParser()).toBe(true);
  });
});
