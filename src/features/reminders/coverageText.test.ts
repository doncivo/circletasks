import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../../i18n';
import { asLocalDateTime } from '../../domain/types';
import { fr } from '../../i18n/fr';
import { en } from '../../i18n/en';
import { formatCoverage } from './coverageText';

const NOW = asLocalDateTime('2026-10-07T10:00');

afterEach(() => setLocale('fr'));

describe('texte de couverture du plan (N-TECH-01 critère 21)', () => {
  it('jusqu’à une échéance : date et heure en 24 h', () => {
    expect(formatCoverage({ state: 'until', until: asLocalDateTime('2026-11-12T21:00') }, NOW)).toBe('Planifiés jusqu’au 12 nov. à 21:00');
    expect(formatCoverage({ state: 'until', until: asLocalDateTime('2026-11-08T07:30') }, NOW)).toBe('Planifiés jusqu’au 8 nov. à 07:30');
    expect(formatCoverage({ state: 'until', until: asLocalDateTime('2026-12-31T23:59') }, NOW)).toBe('Planifiés jusqu’au 31 déc. à 23:59');
  });

  it('tous planifiés et aucun rappel', () => {
    expect(formatCoverage({ state: 'complete' }, NOW)).toBe('Tous les rappels sont planifiés');
    expect(formatCoverage({ state: 'empty' }, NOW)).toBe('Aucun rappel à planifier');
  });

  it('en anglais aussi', () => {
    setLocale('en');
    expect(formatCoverage({ state: 'complete' }, NOW)).toBe('All reminders are scheduled');
    expect(formatCoverage({ state: 'empty' }, NOW)).toBe('No reminders to schedule');
    expect(formatCoverage({ state: 'until', until: asLocalDateTime('2026-11-12T21:00') }, NOW)).toMatch(/^Scheduled until Nov 12 at 21:00$/);
  });

  it('les clés existent dans les deux langues', () => {
    for (const messages of [fr, en]) {
      for (const key of ['coverageUntil', 'coverageDateTime', 'coverageComplete', 'coverageEmpty'] as const) expect(messages.reminders[key]).not.toBe('');
    }
  });
});

describe('année de la couverture (revue)', () => {
  it('l’année est ajoutée quand elle diffère de celle de now', () => {
    expect(formatCoverage({ state: 'until', until: asLocalDateTime('2028-03-12T09:00') }, NOW)).toBe('Planifiés jusqu’au 12 mars 2028 à 09:00');
    expect(formatCoverage({ state: 'until', until: asLocalDateTime('2027-01-02T09:00') }, NOW)).toBe('Planifiés jusqu’au 2 janv. 2027 à 09:00');
  });

  it('pas d’année dans l’année courante, y compris au 31 décembre', () => {
    expect(formatCoverage({ state: 'until', until: asLocalDateTime('2026-12-31T23:59') }, NOW)).toBe('Planifiés jusqu’au 31 déc. à 23:59');
  });

  it('en anglais', () => {
    setLocale('en');
    expect(formatCoverage({ state: 'until', until: asLocalDateTime('2028-03-12T09:00') }, NOW)).toBe('Scheduled until Mar 12, 2028 at 09:00');
  });
});
