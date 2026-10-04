import { describe, expect, it } from 'vitest';
import { externalEventRowId, externalWindowDays } from './calendarProvider';
import type { CalendarAccountId, LocalDate } from './types';

describe('contrat CalendarProvider (ADR 0008)', () => {
  it('fenêtre chargée : 60 jours avant, 400 jours après (K-01 D3)', () => {
    expect(externalWindowDays('2026-10-04' as LocalDate)).toEqual({ first: '2026-08-05', last: '2027-11-08' });
  });

  it('identifiant de ligne déterministe et sans collision de séparateur (K-04 D4)', () => {
    const account = 'acc-1' as CalendarAccountId;
    expect(externalEventRowId(account, 'cal', 'evt')).toBe(externalEventRowId(account, 'cal', 'evt'));
    expect(externalEventRowId(account, 'a|b', 'c')).not.toBe(externalEventRowId(account, 'a', 'b|c'));
  });

  it.todo('K-03 : toExternalEvents, shouldRefresh, nextAccountState, calendarAppStatuses');
});
