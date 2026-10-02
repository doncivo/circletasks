import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from './index';
import { formatNextOccurrences, scheduleLong, scheduleShort, weekdayName } from './formatRoutine';

describe('formatRoutine', () => {
  afterEach(() => setLocale('fr'));

  it('noms de jours : lundi = 1', () => {
    expect(weekdayName(1, 'short')).toBe('lun.');
    expect(weekdayName(7, 'long')).toBe('dimanche');
  });

  it('fréquence courte (ligne de la carte)', () => {
    expect(scheduleShort({ scheduleType: 'daily', weekdays: [], timesPerWeek: null, interval: null })).toBe('');
    expect(scheduleShort({ scheduleType: 'weekdays', weekdays: [1, 3, 5], timesPerWeek: null, interval: null })).toBe('lun., mer., ven.');
    expect(scheduleShort({ scheduleType: 'x_per_week', weekdays: [], timesPerWeek: 3, interval: null })).toBe('3 fois par semaine');
    expect(scheduleShort({ scheduleType: 'every_n_days', weekdays: [], timesPerWeek: null, interval: 3 })).toBe('tous les 3 jours');
    expect(scheduleShort({ scheduleType: 'every_n_weeks', weekdays: [1, 4], timesPerWeek: null, interval: 2 })).toBe('toutes les 2 semaines : lun., jeu.');
    expect(scheduleShort({ scheduleType: 'autre' as never, weekdays: [], timesPerWeek: null, interval: null })).toBe('');
  });

  it('fréquence complète (rapport)', () => {
    expect(scheduleLong({ scheduleType: 'daily', weekdays: [], timesPerWeek: null, interval: null })).toBe('Tous les jours');
    expect(scheduleLong({ scheduleType: 'weekdays', weekdays: [1, 3, 5], timesPerWeek: null, interval: null })).toBe('Lundi, mercredi, vendredi');
    expect(scheduleLong({ scheduleType: 'x_per_week', weekdays: [], timesPerWeek: 2, interval: null })).toBe('2 fois par semaine');
    expect(scheduleLong({ scheduleType: 'every_n_days', weekdays: [], timesPerWeek: null, interval: 5 })).toBe('Tous les 5 jours');
    expect(scheduleLong({ scheduleType: 'every_n_weeks', weekdays: [2], timesPerWeek: null, interval: 4 })).toBe('Toutes les 4 semaines : mardi');
    expect(scheduleLong({ scheduleType: 'autre' as never, weekdays: [], timesPerWeek: null, interval: null })).toBe('');
  });

  it('prochaines fois : le mois n’est écrit qu’en fin de mois (R-07 critère 3)', () => {
    expect(formatNextOccurrences(['2026-09-24', '2026-09-27', '2026-09-30', '2026-10-03'])).toBe('jeu. 24, dim. 27, mer. 30 sept., sam. 3 oct.');
    expect(formatNextOccurrences(['2026-10-05'])).toBe('lun. 5 oct.');
    expect(formatNextOccurrences([])).toBe('');
  });

  it('en anglais', () => {
    setLocale('en');
    expect(scheduleShort({ scheduleType: 'every_n_days', weekdays: [], timesPerWeek: null, interval: 3 })).toBe('every 3 days');
  });
});
