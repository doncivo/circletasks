import { describe, expect, it } from 'vitest';
import { mergeReminderOffsets, normalizeReminderOffsets, routineReminderFireAt, ROUTINE_FORM_OFFSETS } from './routineReminder';
import { d, makeRoutine, time } from './routineTestKit';

describe('rappels de routine (R-02)', () => {
  it('aucun rappel sans heure (QB-07)', () => {
    expect(normalizeReminderOffsets([0, 30], null)).toEqual([]);
  });

  it('avances valides, sans doublon, triées', () => {
    expect(normalizeReminderOffsets([30, 0, 30, 7, 1440], time('18:00'))).toEqual([0, 30, 1440]);
    expect(normalizeReminderOffsets([], time('18:00'))).toEqual([]);
  });

  it('le formulaire ne touche pas aux avances qu’il ne montre pas', () => {
    expect(ROUTINE_FORM_OFFSETS).toEqual([0, 30]);
    expect(mergeReminderOffsets([0, 15, 1440], [30])).toEqual([15, 1440, 30]);
    expect(mergeReminderOffsets([], [0, 30])).toEqual([0, 30]);
    expect(mergeReminderOffsets([5], [5 as never, 0])).toEqual([5, 0]);
  });

  it('échéance = prochaine occurrence à l’heure moins l’avance, heure locale flottante', () => {
    const sport = makeRoutine({ scheduleType: 'weekdays', weekdays: [1, 3, 5] });
    // mar. 22 sept. : prochaine occurrence mer. 23 à 18:00.
    expect(routineReminderFireAt(sport, time('18:00'), d('2026-09-22'), 0)).toBe('2026-09-23T18:00');
    expect(routineReminderFireAt(sport, time('18:00'), d('2026-09-22'), 30)).toBe('2026-09-23T17:30');
    // Le jour même : l'occurrence du jour.
    expect(routineReminderFireAt(sport, time('18:00'), d('2026-09-23'), 0)).toBe('2026-09-23T18:00');
    // Avance d'un jour : la veille.
    expect(routineReminderFireAt(sport, time('00:10'), d('2026-09-23'), 30)).toBe('2026-09-22T23:40');
  });

  it('jours d’heure d’été : l’heure reste celle du mur (29 mars, 25 octobre)', () => {
    const daily = makeRoutine();
    expect(routineReminderFireAt(daily, time('02:30'), d('2026-03-29'), 0)).toBe('2026-03-29T02:30');
    expect(routineReminderFireAt(daily, time('02:30'), d('2026-10-25'), 0)).toBe('2026-10-25T02:30');
  });

  it('aucune occurrence à venir : null', () => {
    expect(routineReminderFireAt(makeRoutine({ scheduleType: 'weekdays', weekdays: [] }), time('08:00'), d('2026-09-23'), 0)).toBeNull();
  });
});
