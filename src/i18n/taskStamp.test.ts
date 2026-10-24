import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, setLocale, t } from './index';
import { formatStamp } from './format';

afterEach(() => setLocale(DEFAULT_LOCALE));
describe('UI-FIX-02 : horodatage de création', () => {
  it.each([0, 1, 3])('une seule préposition, date distante de %i jours', (days) => {
    setLocale('fr');
    const now = new Date(2026, 9, 24, 12).getTime();
    const created = formatStamp(new Date(2026, 9, 24 - days, 10).toISOString(), now);
    const line = t('detail.createdModified', { created, modified: created });
    expect(line).not.toContain('le le');
    expect(line).not.toMatch(/le (aujourd’hui|aujourd'hui|hier)/);
    expect(line).toBe(`Créée ${created} · modifiée ${created}`);
  });
});
