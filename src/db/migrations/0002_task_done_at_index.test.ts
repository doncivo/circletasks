import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../../domain/clock';
import { createHlcClock, createWriteStamper } from '../../domain/hlc';
import { donePeriodInstants, donePeriodOf } from '../../domain/donePeriod';
import { asEntityId, asLocalDate, type DeviceId, type IsoDateTime, type TaskId } from '../../domain/types';
import type { SqlDriver } from '../driver';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate, readAppliedMigrations } from '../migrator';
import { createDataAccess } from '../repositories/dataAccess';
import { createSqlRepositories } from '../repositories/sql';
import { SPACE_PRO_ID } from '../seed/defaultSpaces';
import { sampleTask } from '../seed/sampleData';
import { migrations } from './index';
import { migration0001CoreTables } from './0001_core_tables';

describe('migration 0002 (T-07) : index done_at sur une base 0001 avec données', () => {
  let db: SqlDriver;
  beforeEach(async () => {
    db = await openSqliteWasmDriver();
  });
  afterEach(() => db.close());

  it('s’applique sans perte sur une base 0001 peuplée, puis est rejouable sans effet', async () => {
    await migrate(db, [migration0001CoreTables]);
    const clock = createManualClock('2026-10-01T08:00:00.000Z');
    const deviceId = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000b2');
    const stamper = createWriteStamper(clock, createHlcClock({ clock, deviceId }));
    const data = createDataAccess(db, stamper, createSqlRepositories);
    const id = asEntityId<TaskId>('70000000-0000-4000-8000-000000000001');
    await data.repos.tasks.create(sampleTask({ id, title: 'Avant 0002', spaceId: SPACE_PRO_ID, date: asLocalDate('2026-09-23') }));
    await data.repos.tasks.complete(id, new Date('2026-09-23T18:04:00').toISOString() as IsoDateTime);

    const report = await migrate(db, migrations);
    expect(report.applied).toEqual([2]);
    const again = await migrate(db, migrations);
    expect(again.applied).toEqual([]);
    expect((await readAppliedMigrations(db)).map((m) => m.version)).toEqual([1, 2]);

    const idx = await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_status_done_at'");
    expect(idx).toHaveLength(1);
    const done = await data.repos.tasks.listDone(donePeriodInstants(donePeriodOf('day', asLocalDate('2026-09-23'))), 'all');
    expect(done.map((t) => t.id)).toEqual([id]);
  });
});
