import { describe, expect, it } from 'vitest';
import type { LocalDate } from '../../../domain/types';
import { occurrenceDates, parseRecurrenceRule } from './recurrence';

const day = (value: string): LocalDate => value as LocalDate;

function dates(rule: string, start: string, last: string, until: string | null = null): string[] {
  const parsed = parseRecurrenceRule(rule);
  if (!parsed) throw new Error(`règle illisible : ${rule}`);
  return occurrenceDates(parsed, { start: day(start), last: day(last), pastUntil: (date) => until !== null && date > day(until) });
}

describe('parseRecurrenceRule', () => {
  it('refuse une règle illisible ou non gérée', () => {
    expect(parseRecurrenceRule('')).toBeNull();
    expect(parseRecurrenceRule('FREQ=HOURLY;COUNT=3')).toBeNull();
    expect(parseRecurrenceRule('FREQ=DAILY;INTERVAL=0')).toBeNull();
    expect(parseRecurrenceRule('FREQ=DAILY;COUNT=abc')).toBeNull();
    expect(parseRecurrenceRule('FREQ=WEEKLY;BYDAY=XX')).toBeNull();
    expect(parseRecurrenceRule('FREQ=YEARLY;BYWEEKNO=20')).toBeNull();
    expect(parseRecurrenceRule('FREQ=YEARLY;BYYEARDAY=100')).toBeNull();
  });

  it('lit les rangs de BYDAY, les listes et WKST', () => {
    expect(parseRecurrenceRule('FREQ=MONTHLY;BYDAY=-1FR,2MO;BYSETPOS=1;WKST=SU;INTERVAL=2;COUNT=5')).toMatchObject({
      frequency: 'MONTHLY',
      interval: 2,
      count: 5,
      byDay: [
        { ordinal: -1, weekday: 5 },
        { ordinal: 2, weekday: 1 },
      ],
      bySetPos: [1],
      weekStart: 7,
    });
  });
});

describe('occurrenceDates', () => {
  it('DAILY avec INTERVAL et COUNT', () => {
    expect(dates('FREQ=DAILY;INTERVAL=2;COUNT=4', '2026-09-22', '2026-12-31')).toEqual(['2026-09-22', '2026-09-24', '2026-09-26', '2026-09-28']);
  });

  it('COUNT compte depuis le début de la série, même avant la plage', () => {
    expect(dates('FREQ=DAILY;COUNT=5', '2026-09-20', '2026-09-22')).toEqual(['2026-09-20', '2026-09-21', '2026-09-22']);
  });

  it('WEEKLY : plusieurs jours, semaine commençant le lundi puis le dimanche', () => {
    expect(dates('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5', '2026-09-23', '2026-12-31')).toEqual(['2026-09-23', '2026-09-25', '2026-09-28', '2026-09-30', '2026-10-02']);
    // Un jour sur deux semaines, début le dimanche 27 : avec WKST=SU la semaine de départ contient dimanche 27 et mardi 29.
    expect(dates('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=SU;COUNT=3', '2026-09-27', '2026-12-31')).toEqual(['2026-09-27', '2026-09-29', '2026-10-11']);
  });

  it('MONTHLY : le 31 saute les mois courts ; jours négatifs ; rang de jour de semaine ; BYSETPOS', () => {
    expect(dates('FREQ=MONTHLY;COUNT=4', '2026-01-31', '2027-12-31')).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
    expect(dates('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3', '2026-01-31', '2027-12-31')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(dates('FREQ=MONTHLY;BYDAY=2TU;COUNT=3', '2026-09-08', '2027-12-31')).toEqual(['2026-09-08', '2026-10-13', '2026-11-10']);
    expect(dates('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3', '2026-09-30', '2027-12-31')).toEqual(['2026-09-30', '2026-10-30', '2026-11-30']);
  });

  it('YEARLY : 29 février seulement les années bissextiles ; BYMONTH ; rang dans l’année', () => {
    expect(dates('FREQ=YEARLY;COUNT=2', '2024-02-29', '2040-12-31')).toEqual(['2024-02-29', '2028-02-29']);
    expect(dates('FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=15;COUNT=4', '2026-03-15', '2030-12-31')).toEqual(['2026-03-15', '2026-09-15', '2027-03-15', '2027-09-15']);
    expect(dates('FREQ=YEARLY;BYDAY=20MO;COUNT=2', '2026-05-18', '2030-12-31')).toEqual(['2026-05-18', '2027-05-17']);
  });

  it('UNTIL arrête la série ; la plage la borne ; avant DTSTART rien', () => {
    expect(dates('FREQ=DAILY', '2026-09-22', '2026-12-31', '2026-09-24')).toEqual(['2026-09-22', '2026-09-23', '2026-09-24']);
    expect(dates('FREQ=DAILY', '2026-09-22', '2026-09-23')).toEqual(['2026-09-22', '2026-09-23']);
    expect(dates('FREQ=WEEKLY;BYDAY=MO,SU', '2026-09-23', '2026-09-30')).toEqual(['2026-09-27', '2026-09-28']);
  });

  it('une règle sans aucune date possible ne boucle pas', () => {
    expect(dates('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', '2026-02-10', '2040-01-01')).toEqual([]);
  });
});
