import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newEntityId, uuidGenerator } from '../../../domain/id';
import { asEntityId, asLocalDate as d, type DeviceId, type HolidayId } from '../../../domain/types';
import type { NewHoliday } from '../holidayRepository';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000009');

const lunar = (key: string, date: string, year = 2026): NewHoliday => ({
  id: newEntityId<HolidayId>(uuidGenerator),
  country: 'TN',
  year,
  key,
  date: d(date),
  name: key,
  kind: 'lunar',
  source: 'table',
  overridden: false,
});

describe('HolidayRepository (SQL) — table annuelle et saisie manuelle (E-03)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });
  afterEach(async () => {
    await db.close();
  });
  const repo = () => db.data.repos.holidays;

  it('rapproche la table : insère, puis ne réécrit rien quand tout est à jour', async () => {
    const rows = [lunar('eidAlFitr', '2026-03-20'), lunar('eidAlAdha', '2026-05-27'), lunar('eidAlFitr', '2027-03-09', 2027)];
    expect(await repo().syncTable(rows)).toBe(3);
    const stored = await repo().listForYears([2026, 2027]);
    expect(stored.map((h) => [h.year, h.key, h.date, h.source, h.overridden])).toEqual([
      [2026, 'eidAlAdha', '2026-05-27', 'table', false],
      [2026, 'eidAlFitr', '2026-03-20', 'table', false],
      [2027, 'eidAlFitr', '2027-03-09', 'table', false],
    ]);
    const hlcBefore = stored.map((h) => h.hlc);
    db.clock.advance(10);
    expect(await repo().syncTable(rows.map((row) => ({ ...row, id: newEntityId<HolidayId>(uuidGenerator) })))).toBe(0);
    expect((await repo().listForYears([2026, 2027])).map((h) => h.hlc)).toEqual(hlcBefore);
    expect(await repo().listForYears([])).toEqual([]);
    expect(await repo().listForYears([2030])).toEqual([]);
  });

  it('une nouvelle version de la table met à jour les dates non saisies et JAMAIS une saisie manuelle (critère 6)', async () => {
    await repo().syncTable([lunar('eidAlFitr', '2026-03-20'), lunar('mouled', '2026-08-25')]);
    const manual = await repo().setOverride(lunar('eidAlFitr', '2026-03-20'), d('2026-03-21'));
    expect(manual).toMatchObject({ date: '2026-03-21', source: 'manual', overridden: true });
    db.clock.advance(10);
    // Mise à jour de l'app : la table embarquée change (Aïd el-Fitr 22 mars, Mouled 26 août).
    expect(await repo().syncTable([lunar('eidAlFitr', '2026-03-22'), lunar('mouled', '2026-08-26')])).toBe(1);
    const after = await repo().listForYears([2026]);
    expect(after.find((h) => h.key === 'eidAlFitr')).toMatchObject({ date: '2026-03-21', source: 'manual', overridden: true, hlc: manual.hlc });
    expect(after.find((h) => h.key === 'mouled')).toMatchObject({ date: '2026-08-26', source: 'table', overridden: false });
  });

  it('saisie manuelle : crée la ligne absente (année hors table), met à jour sinon, change le hlc', async () => {
    const first = await repo().setOverride(lunar('mouled', '2031-07-02', 2031), d('2031-07-03'));
    expect(first).toMatchObject({ year: 2031, date: '2031-07-03', source: 'manual', overridden: true });
    db.clock.advance(5);
    const second = await repo().setOverride(lunar('mouled', '2031-07-02', 2031), d('2031-07-04'));
    expect(second.id).toBe(first.id);
    expect(second.date).toBe('2031-07-04');
    expect(second.hlc > first.hlc).toBe(true);
    expect(await repo().getByKey('TN', 2031, 'mouled')).toMatchObject({ date: '2031-07-04' });
    expect(await repo().getByKey('TN', 2031, 'eidAlFitr')).toBeNull();
  });

  it('« Rétablir la date de la table » : date de la table, source table, overridden faux', async () => {
    await repo().syncTable([lunar('eidAlFitr', '2026-03-20')]);
    await repo().setOverride(lunar('eidAlFitr', '2026-03-20'), d('2026-03-21'));
    const restored = await repo().clearOverride('TN', 2026, 'eidAlFitr', d('2026-03-20'));
    expect(restored).toMatchObject({ date: '2026-03-20', source: 'table', overridden: false });
    expect(await repo().clearOverride('TN', 2026, 'absent', d('2026-03-20'))).toBeNull();
  });

  it('sans date de table (année non couverte), rétablir supprime la ligne ; une saisie ultérieure la ranime', async () => {
    const created = await repo().setOverride(lunar('mouled', '2031-07-02', 2031), d('2031-07-03'));
    expect(await repo().clearOverride('TN', 2031, 'mouled', null)).toBeNull();
    expect(await repo().getByKey('TN', 2031, 'mouled')).toBeNull();
    expect(await repo().listForYears([2031])).toEqual([]);
    const revived = await repo().setOverride(lunar('mouled', '2031-07-02', 2031), d('2031-07-05'));
    expect(revived.id).toBe(created.id);
    expect(revived).toMatchObject({ date: '2031-07-05', deletedAt: null });
  });

  it('la ligne supprimée logiquement est remise à jour par le rapprochement de la table', async () => {
    await repo().syncTable([lunar('mouled', '2026-08-25')]);
    await repo().clearOverride('TN', 2026, 'mouled', null);
    expect(await repo().listForYears([2026])).toEqual([]);
    expect(await repo().syncTable([lunar('mouled', '2026-08-25')])).toBe(1);
    expect(await repo().listForYears([2026])).toHaveLength(1);
  });
});
