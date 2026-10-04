import { describe, expect, it } from 'vitest';
import { externalEventRowId, externalFetchRange, externalWindowDays, toExternalEvents, toStoredInstant, type ProviderEvent } from './calendarProvider';
import type { CalendarAccountId, IsoDateTime, LocalDate } from './types';

describe('contrat CalendarProvider (ADR 0008)', () => {
  it('fenêtre chargée : 60 jours avant, 400 jours après (K-01 D3)', () => {
    expect(externalWindowDays('2026-10-04' as LocalDate)).toEqual({ first: '2026-08-05', last: '2027-11-08' });
  });

  it('identifiant de ligne déterministe et sans collision de séparateur (K-04 D4)', () => {
    const account = 'acc-1' as CalendarAccountId;
    expect(externalEventRowId(account, 'cal', 'evt')).toBe(externalEventRowId(account, 'cal', 'evt'));
    expect(externalEventRowId(account, 'a|b', 'c')).not.toBe(externalEventRowId(account, 'a', 'b|c'));
  });

  it('plage UTC : minuit local du premier jour moins un jour, minuit local suivant le dernier plus un jour', () => {
    const range = externalFetchRange('2026-10-04' as LocalDate, 'Europe/Paris');
    // 5 août 00:00 Paris (UTC+2) = 4 août 22:00 UTC, moins un jour ; 9 nov. 00:00 Paris (UTC+1) = 8 nov. 23:00 UTC, plus un jour.
    expect(range).toEqual({ fromUtc: '2026-08-03T22:00:00Z', toUtc: '2027-11-09T23:00:00Z' });
  });

  it('instants stockés sans millisecondes', () => {
    expect(toStoredInstant(Date.UTC(2026, 8, 23, 8, 0))).toBe('2026-09-23T08:00:00Z');
    expect(toStoredInstant(Date.UTC(2026, 8, 23, 8, 0, 0, 5))).toBe('2026-09-23T08:00:00.005Z');
  });
});

describe('toExternalEvents (K-03)', () => {
  const account = 'acc-1' as CalendarAccountId;
  const syncedAt = '2026-10-04T10:00:00Z' as IsoDateTime;
  const event = (patch: Partial<ProviderEvent>): ProviderEvent => ({ calendarId: 'cal', externalId: 'e1', title: 'Point client', startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z', allDay: false, ...patch });

  it('id déterministe, horodatage, journée entière inchangée, titre vide conservé', () => {
    const [row, second] = toExternalEvents(account, [event({}), event({ externalId: 'e2', title: '', allDay: true, startUtc: '2026-09-25', endUtc: '2026-09-26' })], syncedAt);
    expect(row).toEqual({ id: externalEventRowId(account, 'cal', 'e1'), accountId: account, calendarId: 'cal', externalId: 'e1', title: 'Point client', startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z', allDay: false, syncedAt });
    expect(second).toMatchObject({ title: '', allDay: true, startUtc: '2026-09-25', endUtc: '2026-09-26' });
  });

  it('deux instances de même identifiant : la dernière gagne, sans doublon', () => {
    const rows = toExternalEvents(account, [event({ title: 'Ancien' }), event({ title: 'Nouveau' })], syncedAt);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Nouveau');
  });
});
