import { createManualClock, type ManualClock } from '../../../domain/clock';
import { createHlcClock, createWriteStamper } from '../../../domain/hlc';
import type { DeviceId } from '../../../domain/types';
import type { SqlDriver } from '../../driver';
import { openSqliteWasmDriver } from '../../drivers/sqliteWasm';
import { migrations } from '../../migrations';
import { migrate } from '../../migrator';
import { createDataAccess, type DataAccess } from '../dataAccess';
import { createSqlRepositories } from './index';

/**
 * Base de test : driver SQLite Wasm en mémoire, migrations de l'app appliquées,
 * `DataAccess` branché sur `createSqlRepositories` avec une horloge manuelle
 * (hlc et updated_at déterministes, avançables avec `clock.advance(ms)`).
 */
export interface TestDb {
  readonly driver: SqlDriver;
  readonly data: DataAccess;
  readonly clock: ManualClock;
  readonly deviceId: DeviceId;
  close(): Promise<void>;
}

export async function openTestDb(
  deviceId: DeviceId,
  startAt: string | number = '2026-10-01T08:00:00.000Z',
): Promise<TestDb> {
  const driver = await openSqliteWasmDriver();
  await migrate(driver, migrations);
  const clock = createManualClock(startAt);
  const hlc = createHlcClock({ clock, deviceId });
  const stamper = createWriteStamper(clock, hlc);
  const data = createDataAccess(driver, stamper, createSqlRepositories);
  return { driver, data, clock, deviceId, close: () => driver.close() };
}
