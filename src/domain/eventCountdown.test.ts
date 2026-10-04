import { describe, expect, it } from 'vitest';
import { countdownOf, daysUntil, nextCountdown } from './eventCountdown';
import { makeEvent } from './eventTestKit';
import { asLocalDate as d, asLocalTime as tm } from './types';

describe('compte à rebours (E-04)', () => {
  it('jours calendaires entre deux dates civiles : 12, 1, 0, négatif', () => {
    expect(daysUntil(d('2026-10-05'), d('2026-09-23'))).toBe(12);
    expect(daysUntil(d('2026-09-24'), d('2026-09-23'))).toBe(1);
    expect(daysUntil(d('2026-09-23'), d('2026-09-23'))).toBe(0);
    expect(daysUntil(d('2026-09-22'), d('2026-09-23'))).toBe(-1);
  });

  it('sans décalage au changement d’heure ni à travers les années (critère 3)', () => {
    // Passage à l'heure d'hiver 2026 (25 octobre, journée de 25 h) et à l'heure d'été (29 mars, 23 h) : toujours des jours entiers.
    expect(daysUntil(d('2026-10-26'), d('2026-10-24'))).toBe(2);
    expect(daysUntil(d('2026-10-25'), d('2026-10-24'))).toBe(1);
    expect(daysUntil(d('2026-03-30'), d('2026-03-28'))).toBe(2);
    expect(daysUntil(d('2026-03-29'), d('2026-03-28'))).toBe(1);
    expect(daysUntil(d('2027-01-01'), d('2026-12-31'))).toBe(1);
    expect(daysUntil(d('2028-03-01'), d('2028-02-28'))).toBe(2);
    expect(daysUntil(d('2027-03-01'), d('2027-02-28'))).toBe(1);
  });

  it('le jour même « Aujourd’hui » (0), la veille J-1, après aucun compte (critère 2)', () => {
    const span = { date: d('2026-09-25'), endDate: d('2026-09-25') };
    expect(countdownOf(span, d('2026-09-23'))).toBe(2);
    expect(countdownOf(span, d('2026-09-24'))).toBe(1);
    expect(countdownOf(span, d('2026-09-25'))).toBe(0);
    expect(countdownOf(span, d('2026-09-26'))).toBeNull();
  });

  it('une plage de plusieurs jours est « Aujourd’hui » pendant toute sa durée', () => {
    const span = { date: d('2026-09-25'), endDate: d('2026-09-27') };
    expect([d('2026-09-24'), d('2026-09-25'), d('2026-09-26'), d('2026-09-27'), d('2026-09-28')].map((today) => countdownOf(span, today))).toEqual([1, 0, 0, 0, null]);
  });

  it('une série : vers la prochaine occurrence à venir (critère 6)', () => {
    const monthly = makeEvent({ startDate: '2026-01-31', repeat: 'monthly' });
    expect(nextCountdown(monthly, d('2026-02-20'))).toBe(8); // 28 févr.
    expect(nextCountdown(monthly, d('2026-02-28'))).toBe(0);
    expect(nextCountdown(monthly, d('2026-03-01'))).toBe(30); // 31 mars
    const birthday = makeEvent({ startDate: '1992-09-25', repeat: 'yearly', kind: 'birthday', birthYear: 1992 });
    expect(nextCountdown(birthday, d('2026-09-23'))).toBe(2);
    expect(nextCountdown(birthday, d('2026-09-25'))).toBe(0);
    expect(nextCountdown(birthday, d('2026-09-26'))).toBe(364);
    const leap = makeEvent({ startDate: '2024-02-29', repeat: 'yearly' });
    expect(nextCountdown(leap, d('2027-02-20'))).toBe(8); // 28 févr. 2027
  });

  it('événement unique : futur, aujourd’hui, passé ; plage de plusieurs jours en cours', () => {
    const once = makeEvent({ startDate: '2026-10-05' });
    expect(nextCountdown(once, d('2026-09-23'))).toBe(12);
    expect(nextCountdown(once, d('2026-10-05'))).toBe(0);
    expect(nextCountdown(once, d('2026-10-06'))).toBeNull();
    const range = makeEvent({ allDay: false, startTime: tm('22:00'), endTime: tm('02:00'), startDate: '2026-10-05', endDate: '2026-10-06' });
    expect(nextCountdown(range, d('2026-10-06'))).toBe(0);
  });
});
