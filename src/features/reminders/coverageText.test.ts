import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../../i18n';
import { asLocalDateTime } from '../../domain/types';
import { fr } from '../../i18n/fr';
import { en } from '../../i18n/en';
import { formatCoverage } from './coverageText';

afterEach(() => setLocale('fr'));

describe('texte de couverture du plan (N-TECH-01 critère 21)', () => {
  it('jusqu’à une échéance : date et heure en 24 h', () => {
    expect(formatCoverage({ state: 'until', until: asLocalDateTime('2026-11-12T21:00') })).toBe('Planifiés jusqu’au 12 nov. à 21:00');
    expect(formatCoverage({ state: 'until', until: asLocalDateTime('2026-11-08T07:30') })).toBe('Planifiés jusqu’au 8 nov. à 07:30');
    expect(formatCoverage({ state: 'until', until: asLocalDateTime('2026-12-31T23:59') })).toBe('Planifiés jusqu’au 31 déc. à 23:59');
  });

  it('tous planifiés et aucun rappel', () => {
    expect(formatCoverage({ state: 'complete' })).toBe('Tous les rappels sont planifiés');
    expect(formatCoverage({ state: 'empty' })).toBe('Aucun rappel à planifier');
  });

  it('en anglais aussi', () => {
    setLocale('en');
    expect(formatCoverage({ state: 'complete' })).toBe('All reminders are scheduled');
    expect(formatCoverage({ state: 'empty' })).toBe('No reminders to schedule');
    expect(formatCoverage({ state: 'until', until: asLocalDateTime('2026-11-12T21:00') })).toMatch(/^Scheduled until Nov 12 at 21:00$/);
  });

  it('les clés existent dans les deux langues', () => {
    for (const messages of [fr, en]) {
      for (const key of ['coverageUntil', 'coverageDateTime', 'coverageComplete', 'coverageEmpty'] as const) expect(messages.reminders[key]).not.toBe('');
    }
  });
});
