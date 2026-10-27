import { describe, expect, it } from 'vitest';
import type { QuietHours, Routine } from './model';
import { DEFAULT_PRO_QUIET_HOURS } from './quietHours';
import { quietShift, routineQuietSummary } from './quietShift';
import { asLocalDate, asLocalDateTime, type LocalTime, type Weekday } from './types';

/**
 * N-FIX-04 (décision d'Ali du 2026-10-27) : au moment du choix d'une heure de rappel couverte par une plage silencieuse, l'app le dit ;
 * une phrase, une cause. Semaine de référence : lun. 5 oct. 2026 → dim. 11 oct. 2026.
 */
const at = (value: string) => asLocalDateTime(value);
const PRO = DEFAULT_PRO_QUIET_HOURS;
const range = (weekdays: Weekday[], from: string, to: string): QuietHours => ({ weekdays, from: from as LocalTime, to: to as LocalTime });

describe('quietShift : échéance effective et cause unique', () => {
  it('mardi 20:00 Pro : décalé au mercredi 08:00, cause « après 19:00 »', () => {
    expect(quietShift(at('2026-10-06T20:00'), PRO)).toEqual({ fireAt: '2026-10-06T20:00', effective: '2026-10-07T08:00', cause: { kind: 'after', from: '19:00' } });
  });

  it('samedi 20:00 Pro : couvert par le week-end ET par le soir ; une seule cause, celle de la journée entière : « le week-end »', () => {
    expect(quietShift(at('2026-10-10T20:00'), PRO)).toEqual({ fireAt: '2026-10-10T20:00', effective: '2026-10-12T08:00', cause: { kind: 'weekend' } });
  });

  it('samedi 10:00 Pro : décalé au lundi 08:00, cause « le week-end »', () => {
    expect(quietShift(at('2026-10-10T10:00'), PRO)).toMatchObject({ effective: '2026-10-12T08:00', cause: { kind: 'weekend' } });
  });

  it('vendredi 20:00 Pro : décalé au lundi 08:00 ; la cause est la plage qui couvre l’heure choisie, « après 19:00 », pas le week-end traversé ensuite', () => {
    expect(quietShift(at('2026-10-09T20:00'), PRO)).toMatchObject({ effective: '2026-10-12T08:00', cause: { kind: 'after', from: '19:00' } });
  });

  it('mardi 07:30 Pro : décalé à 08:00 le même jour, cause « avant 08:00 » (la plage du soir a commencé la veille)', () => {
    expect(quietShift(at('2026-10-06T07:30'), PRO)).toEqual({ fireAt: '2026-10-06T07:30', effective: '2026-10-06T08:00', cause: { kind: 'before', to: '08:00' } });
  });

  it('journée entière sur un seul jour (mercredi) : cause « le mercredi »', () => {
    const ranges = [range([3], '00:00', '00:00')];
    expect(quietShift(at('2026-10-07T10:00'), ranges)).toMatchObject({ effective: '2026-10-08T00:00', cause: { kind: 'all-day', weekdays: [3] } });
  });

  it('aucune plage (Perso), heure hors plage, ou silence continu sur la semaine : null, rien à dire', () => {
    expect(quietShift(at('2026-10-06T20:00'), [])).toBeNull();
    expect(quietShift(at('2026-10-06T10:00'), PRO)).toBeNull();
    expect(quietShift(at('2026-10-06T10:00'), [range([1, 2, 3, 4, 5, 6, 7], '00:00', '00:00')])).toBeNull();
  });
});

const routine = (over: Partial<Routine>): Routine =>
  ({
    id: 'r1',
    spaceId: 'pro',
    title: 'Yoga',
    icon: null,
    scheduleType: 'daily',
    weekdays: [],
    timesPerWeek: null,
    interval: null,
    startDate: asLocalDate('2026-09-01'),
    time: '20:00' as LocalTime,
    paused: false,
    archived: false,
    deletedAt: null,
    ...over,
  }) as Routine;

describe('routineQuietSummary : trois états pour la ligne de l’écran Routines (demande d’Ali : jamais silencieux par défaut)', () => {
  const from = asLocalDate('2026-10-05'); // lundi

  it('Pro, tous les jours à 20:00 : tous les rappels décalés, tous à 08:00', () => {
    expect(routineQuietSummary(routine({}), [0], PRO, from)).toEqual({ state: 'all', time: '08:00' });
  });

  it('Pro, tous les jours à 10:00 : décalage partiel, les occurrences du week-end partent au lundi 08:00', () => {
    expect(routineQuietSummary(routine({ time: '10:00' as LocalTime }), [0], PRO, from)).toEqual({ state: 'partial', weekdays: [6, 7], target: { weekday: 1, time: '08:00' } });
  });

  it('Pro, jours choisis lundi à vendredi à 10:00 : aucun décalage sur les sept prochaines occurrences', () => {
    expect(routineQuietSummary(routine({ scheduleType: 'weekdays', weekdays: [1, 2, 3, 4, 5], time: '10:00' as LocalTime }), [0], PRO, from)).toEqual({ state: 'none' });
  });

  it('Perso (aucune plage), sans heure, ou sans rappel : aucun décalage', () => {
    expect(routineQuietSummary(routine({}), [0], [], from)).toEqual({ state: 'none' });
    expect(routineQuietSummary(routine({ time: null }), [0], PRO, from)).toEqual({ state: 'none' });
    expect(routineQuietSummary(routine({}), [], PRO, from)).toEqual({ state: 'none' });
  });

  it('avance de 30 min à 19:15 : le rappel 18:45 passe, celui « à l’heure » 19:15 est décalé : partiel sur chaque jour, cible 08:00 sans jour unique', () => {
    expect(routineQuietSummary(routine({ time: '19:15' as LocalTime }), [0, 30], PRO, from)).toEqual({ state: 'partial', weekdays: [1, 2, 3, 4, 5, 6, 7], target: { weekday: null, time: '08:00' } });
  });

  it('routine en pause sur toute la période : aucune occurrence, rien', () => {
    expect(routineQuietSummary(routine({}), [0], PRO, from, [{ from: asLocalDate('2026-10-05'), to: asLocalDate('2026-10-20') }])).toEqual({ state: 'none' });
  });
});
