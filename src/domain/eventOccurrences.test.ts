import { describe, expect, it } from 'vitest';
import { nextOccurrence, occurrenceStarts, occurrencesInRange } from './eventOccurrences';
import { makeEvent } from './eventTestKit';
import { asLocalDate as d, asLocalTime as tm } from './types';

const starts = (event: ReturnType<typeof makeEvent>, from: string, to: string): string[] => occurrenceStarts(event, d(from), d(to));

describe('occurrences des événements (E-01 critère 4, E-02 critère 5)', () => {
  it('Une fois : une seule occurrence, dans la plage ou non', () => {
    const event = makeEvent({ startDate: '2026-09-23' });
    expect(starts(event, '2026-01-01', '2026-12-31')).toEqual(['2026-09-23']);
    expect(starts(event, '2026-09-24', '2026-12-31')).toEqual([]);
    expect(starts(event, '2026-09-23', '2026-09-23')).toEqual(['2026-09-23']);
  });

  it('une plage qui passe minuit touche les deux jours', () => {
    const event = makeEvent({ allDay: false, startTime: tm('22:00'), endTime: tm('02:00'), startDate: '2026-09-23', endDate: '2026-09-24' });
    expect(starts(event, '2026-09-24', '2026-09-24')).toEqual(['2026-09-23']);
    expect(occurrencesInRange(event, d('2026-09-24'), d('2026-09-24'))[0]?.endDate).toBe('2026-09-24');
    expect(starts(event, '2026-09-25', '2026-09-30')).toEqual([]);
  });

  it('Mensuel : même quantième, à partir du mois du début, jamais avant', () => {
    const event = makeEvent({ startDate: '2026-03-05', repeat: 'monthly' });
    expect(starts(event, '2026-01-01', '2026-06-30')).toEqual(['2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05']);
  });

  it('Mensuel : le 31 devient le dernier jour d’un mois plus court (et février bissextile ou non)', () => {
    const event = makeEvent({ startDate: '2026-01-31', repeat: 'monthly' });
    expect(starts(event, '2026-01-01', '2026-06-30')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    expect(starts(event, '2028-02-01', '2028-02-29')).toEqual(['2028-02-29']);
  });

  it('Mensuel : le 29 et le 30 se ramènent aussi au dernier jour', () => {
    expect(starts(makeEvent({ startDate: '2026-01-30', repeat: 'monthly' }), '2027-02-01', '2027-02-28')).toEqual(['2027-02-28']);
    expect(starts(makeEvent({ startDate: '2026-01-29', repeat: 'monthly' }), '2027-02-01', '2027-02-28')).toEqual(['2027-02-28']);
  });

  it('Annuel : même jour chaque année, le 29 févr. devient le 28 les années non bissextiles', () => {
    const event = makeEvent({ startDate: '2024-02-29', repeat: 'yearly' });
    expect(starts(event, '2024-01-01', '2029-12-31')).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29', '2029-02-28']);
    expect(starts(event, '2023-01-01', '2023-12-31')).toEqual([]);
  });

  it('une occurrence multi-jours commencée avant la plage la touche encore', () => {
    const event = makeEvent({ allDay: false, startTime: tm('09:00'), endTime: tm('17:00'), startDate: '2026-01-30', endDate: '2026-02-01', repeat: 'monthly' });
    expect(starts(event, '2026-03-01', '2026-03-01')).toEqual(['2026-02-28']);
    expect(occurrencesInRange(event, d('2026-03-01'), d('2026-03-01'))[0]?.endDate).toBe('2026-03-02');
  });

  it('nextOccurrence : aujourd’hui compris, sinon la suivante ; null pour un événement unique passé', () => {
    const monthly = makeEvent({ startDate: '2026-01-31', repeat: 'monthly' });
    expect(nextOccurrence(monthly, d('2026-02-01'))?.date).toBe('2026-02-28');
    expect(nextOccurrence(monthly, d('2026-02-28'))?.date).toBe('2026-02-28');
    const yearly = makeEvent({ startDate: '1992-09-25', repeat: 'yearly' });
    expect(nextOccurrence(yearly, d('2026-09-26'))?.date).toBe('2027-09-25');
    const once = makeEvent({ startDate: '2026-09-23' });
    expect(nextOccurrence(once, d('2026-09-23'))?.date).toBe('2026-09-23');
    expect(nextOccurrence(once, d('2026-09-24'))).toBeNull();
  });
});
