import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock, createWriteStamper } from '../../domain/hlc';
import { LUNAR_HOLIDAY_KEYS, LUNAR_TABLE_YEARS, lunarTableDate } from '../../domain/holidays';
import { asLocalDate as d } from '../../domain/types';
import { createDataAccess } from '../../db/repositories';
import { createSqlRepositories } from '../../db/repositories/sql';
import { createAppContainer } from '../app/container';
import { createHolidayUseCases, ensureHolidayTable, loadHolidays, readHolidayCountries } from './holidayUseCases';
import { setupEvents, teardownEvents, type EventsHarness } from './testKit';

describe('Cas d’usage des jours fériés (E-03)', () => {
  let h: EventsHarness;
  beforeEach(async () => {
    h = await setupEvents('441', undefined, { holidays: true });
  });
  afterEach(() => teardownEvents(h));

  const rows = () => h.container.data.repos.holidays.listForYears([...LUNAR_TABLE_YEARS]);

  it('la table annuelle est recopiée une fois : 4 fêtes par année de 2026 à 2030, estimées, sans écriture au second passage', async () => {
    await ensureHolidayTable(h.container);
    const stored = await rows();
    expect(stored).toHaveLength(LUNAR_TABLE_YEARS.length * LUNAR_HOLIDAY_KEYS.length);
    expect(stored.every((row) => row.country === 'TN' && row.kind === 'lunar' && row.source === 'table' && !row.overridden)).toBe(true);
    expect(stored.find((row) => row.year === 2026 && row.key === 'eidAlFitr')?.date).toBe('2026-03-20');
    const hlcs = stored.map((row) => row.hlc);
    await ensureHolidayTable(h.container);
    expect((await rows()).map((row) => row.hlc)).toEqual(hlcs);
  });

  it('calendriers : les deux activés par défaut ; désactiver la France ne touche pas la Tunisie ; l’état est conservé (critères 3, 4)', async () => {
    expect(await readHolidayCountries(h.container)).toEqual({ FR: true, TN: true });
    const range = { from: d('2026-01-01'), to: d('2026-12-31') };
    expect((await loadHolidays(h.container, range.from, range.to)).filter((holiday) => holiday.country === 'FR')).toHaveLength(11);
    await createHolidayUseCases(h.container).setCountry('FR', false);
    expect(await readHolidayCountries(h.container)).toEqual({ FR: false, TN: true });
    const after = await loadHolidays(h.container, range.from, range.to);
    expect(after.some((holiday) => holiday.country === 'FR')).toBe(false);
    expect(after.filter((holiday) => holiday.country === 'TN')).toHaveLength(12);
    await createHolidayUseCases(h.container).setCountry('TN', false);
    expect(await loadHolidays(h.container, range.from, range.to)).toEqual([]);
    await createHolidayUseCases(h.container).setCountry('FR', true);
    expect(await readHolidayCountries(h.container)).toEqual({ FR: true, TN: false });
  });

  it('une date saisie prime sur la table, « Rétablir » la restaure ; fixe et calculé non modifiables (critère 5)', async () => {
    const useCases = createHolidayUseCases(h.container);
    const find = async (key: string) => (await loadHolidays(h.container, d('2026-01-01'), d('2026-12-31'))).find((holiday) => holiday.key === key);
    const fitr = await find('eidAlFitr');
    expect(fitr).toMatchObject({ date: '2026-03-20', estimated: true, overridden: false });
    expect(await useCases.overrideDate({ country: 'TN', key: 'eidAlFitr', year: 2026, kind: 'lunar' }, d('2026-03-21'))).toEqual({ ok: true });
    expect(await find('eidAlFitr')).toMatchObject({ date: '2026-03-21', estimated: false, overridden: true, tableDate: '2026-03-20' });
    expect(await useCases.restoreTableDate({ country: 'TN', key: 'eidAlFitr', year: 2026, kind: 'lunar' })).toBe(true);
    expect(await find('eidAlFitr')).toMatchObject({ date: '2026-03-20', estimated: true, overridden: false });
    expect(await useCases.restoreTableDate({ country: 'TN', key: 'eidAlFitr', year: 2026, kind: 'lunar' })).toBe(false);
    expect(await useCases.overrideDate({ country: 'TN', key: 'evacuation', year: 2026, kind: 'fixed' }, d('2026-10-16'))).toEqual({ ok: false, error: 'not-editable' });
    expect(await useCases.overrideDate({ country: 'FR', key: 'easterMonday', year: 2026, kind: 'computed' }, d('2026-04-07'))).toEqual({ ok: false, error: 'not-editable' });
    expect(await useCases.overrideDate({ country: 'TN', key: 'mouled', year: 2026, kind: 'lunar' }, d('2031-01-01'))).toEqual({ ok: false, error: 'invalid-date' });
    expect(await useCases.restoreTableDate({ country: 'FR', key: 'newYear', year: 2026, kind: 'fixed' })).toBe(false);
  });

  it('une saisie manuelle survit à une mise à jour de l’app qui remplace la table annuelle (critère 6)', async () => {
    const useCases = createHolidayUseCases(h.container);
    await useCases.overrideDate({ country: 'TN', key: 'eidAlAdha', year: 2026, kind: 'lunar' }, d('2026-05-28'));
    // « Mise à jour de l'app » : nouvelle session sur la même base, la table est rapprochée de la table embarquée.
    const hlc = createHlcClock({ clock: h.db.clock, deviceId: h.db.deviceId });
    const data = createDataAccess(h.db.driver, createWriteStamper(h.db.clock, hlc), createSqlRepositories);
    const restarted = createAppContainer({ clock: h.db.clock, hlc, data });
    await ensureHolidayTable(restarted);
    const adha = (await rows()).find((row) => row.year === 2026 && row.key === 'eidAlAdha');
    expect(adha).toMatchObject({ date: '2026-05-28', source: 'manual', overridden: true });
    expect(lunarTableDate(2026, 'eidAlAdha')).toBe('2026-05-27');
    expect((await loadHolidays(restarted, d('2026-05-01'), d('2026-05-31'))).find((holiday) => holiday.key === 'eidAlAdha')).toMatchObject({ date: '2026-05-28', overridden: true });
  });

  it('une saisie sur une année hors table (2031) crée la ligne et s’affiche ; sans elle, la fête manque (critère 8)', async () => {
    const useCases = createHolidayUseCases(h.container);
    const range = { from: d('2031-01-01'), to: d('2031-12-31') };
    expect((await loadHolidays(h.container, range.from, range.to)).some((holiday) => holiday.kind === 'lunar')).toBe(false);
    await useCases.overrideDate({ country: 'TN', key: 'mouled', year: 2031, kind: 'lunar' }, d('2031-07-02'));
    expect((await loadHolidays(h.container, range.from, range.to)).filter((holiday) => holiday.kind === 'lunar')).toMatchObject([{ key: 'mouled', date: '2031-07-02', tableDate: null }]);
    expect(await useCases.restoreTableDate({ country: 'TN', key: 'mouled', year: 2031, kind: 'lunar' })).toBe(true);
    expect((await loadHolidays(h.container, range.from, range.to)).some((holiday) => holiday.kind === 'lunar')).toBe(false);
  });
});
