import { describe, expect, it } from 'vitest';
import { holidayId, routineLogId } from '../../domain/sync/naturalIds';
import type { LocalDate, RoutineId } from '../../domain/types';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { migrations } from './index';

const PRO = '00000000-0000-4000-8000-000000000001';
const R1 = '3b241101-e2bb-4255-8caf-4136c566a962';
const DEV = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HLC = `000000000000001-0000-${DEV}`;
const AT = '2026-10-01T08:00:00.000Z';

describe('migration 0016 : identifiants déterministes (Y-02 critère 9)', () => {
  it('base peuplée en version 15 : routine_log et holiday réécrits par les formules de naturalIds.ts, sans entrée dans la file', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations.slice(0, 15));
    await db.execute(`INSERT INTO routine (id, space_id, title, schedule_type, start_date, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Lire', 'daily', '2026-10-01', ?, ?, ?, ?)`, [R1, PRO, AT, AT, DEV, HLC]);
    await db.execute(`INSERT INTO routine_log (id, routine_id, date, done_at, created_at, updated_at, device_id, hlc) VALUES ('11111111-1111-4111-8111-111111111111', ?, '2026-10-02', ?, ?, ?, ?, ?)`, [R1, AT, AT, AT, DEV, HLC]);
    await db.execute(`INSERT INTO holiday (id, country, year, key, date, name, kind, created_at, updated_at, device_id, hlc) VALUES ('22222222-2222-4222-8222-222222222222', 'TN', 2027, 'eidAlFitr', '2027-03-10', 'eidAlFitr', 'lunar', ?, ?, ?, ?)`, [AT, AT, DEV, HLC]);
    await db.execute('DELETE FROM sync_outbox');
    await db.execute("UPDATE routine_log SET done_at = ?, hlc = ? WHERE routine_id = ?", ['2026-10-02T09:00:00.000Z', `000000000000002-0000-${DEV}`, R1]);
    await migrate(db, migrations);
    const rlog = routineLogId(R1 as RoutineId, '2026-10-02' as LocalDate);
    expect(await db.select('SELECT id FROM routine_log')).toEqual([{ id: rlog }]);
    expect(await db.select('SELECT id FROM holiday')).toEqual([{ id: holidayId('TN', 2027, 'eidAlFitr') }]);
    // Horloges et file déjà posées suivent le nouvel identifiant ; la migration elle-même n'ajoute rien.
    expect(await db.select('SELECT row_id, field FROM sync_outbox')).toEqual([{ row_id: rlog, field: 'done_at' }]);
    expect(await db.select("SELECT DISTINCT row_id FROM sync_field_clock")).toEqual([{ row_id: rlog }]);
    expect(await db.select('SELECT * FROM sync_guard')).toEqual([]);
    expect((await migrate(db, migrations)).applied).toEqual([]);
    await db.close();
  });
});
