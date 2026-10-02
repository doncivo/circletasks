import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from './index';
import { formatDonePeriodLabel } from './format';

describe('formatDonePeriodLabel (T-07)', () => {
  afterEach(() => setLocale('fr'));

  it('jour, semaine, semaine à cheval sur deux mois, mois (français)', () => {
    expect(formatDonePeriodLabel('day', '2026-09-23', '2026-09-23')).toBe('23 sept.');
    expect(formatDonePeriodLabel('week', '2026-09-21', '2026-09-27')).toBe('21 – 27 sept.');
    expect(formatDonePeriodLabel('week', '2026-09-28', '2026-10-04')).toBe('28 sept. – 4 oct.');
    expect(formatDonePeriodLabel('month', '2026-09-01', '2026-09-30')).toBe('septembre 2026');
  });

  it('suit la langue courante', () => {
    setLocale('en');
    expect(formatDonePeriodLabel('month', '2026-09-01', '2026-09-30')).toBe('September 2026');
  });
});
