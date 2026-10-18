import { expect } from 'vitest';
import type { HexColor, LocalDate, ProjectId, TaskId } from '../../../src/domain/types';
import type { RestoreMarker } from '../../../src/platform/sync/types';
import { PRO, createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../sim/syncDevice';

/** Y-FIX-04 : banc commun des scénarios de report d'époque avec parent remplacé (sauvegarde, restauration « Appliquer partout »). */

export const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const P_ID = '0f000000-0000-4000-8000-00000000000f' as ProjectId;
export const DAY = '2026-10-05' as LocalDate;

export async function backupOf(device: SimDevice): Promise<Map<string, unknown[]>> {
  const tables = await device.driver.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_index%' AND name NOT LIKE 'sqlite_%'");
  const copy = new Map<string, unknown[]>();
  for (const { name } of tables) copy.set(name, await device.driver.select(`SELECT * FROM ${name}`));
  return copy;
}

export async function restore(device: SimDevice, copy: Map<string, unknown[]>): Promise<void> {
  await device.driver.execute('PRAGMA foreign_keys = OFF');
  await device.driver.transaction(async (tx) => {
    await tx.execute('INSERT INTO sync_guard (id) VALUES (1)');
    for (const [table, rows] of copy) {
      if (table === 'sync_guard' || table === 'schema_migrations') continue;
      await tx.execute(`DELETE FROM ${table}`);
      for (const row of rows as Record<string, string | number | null>[]) {
        const cols = Object.keys(row);
        await tx.execute(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c] ?? null));
      }
    }
    await tx.execute('DELETE FROM sync_guard');
  });
  await device.driver.execute('PRAGMA foreign_keys = ON');
  const marker: RestoreMarker = { backup: 'circletasks-daily-20261005.db', backupTakenAt: '2026-10-05T07:00:00.000Z' as RestoreMarker['backupTakenAt'], restoredAt: new Date(device.clock.nowMs()).toISOString() as RestoreMarker['restoredAt'], schemaVersion: 17 };
  device.platform.testing.setRestoreMarker(marker);
  await device.restart();
}

/** A (PC, ouvreur des restaurations) et B (iPhone) associés et synchronisés. */
export async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  syncFolders([a, b]);
  await a.cycle();
  syncFolders([a, b]);
  return [a, b];
}

export async function rounds(devices: readonly SimDevice[], n = 4): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    for (const d of devices) {
      await d.cycle();
      syncFolders(devices);
    }
  }
}

export async function applyEverywhere(opener: SimDevice, copy: Map<string, unknown[]>): Promise<void> {
  await restore(opener, copy);
  expect((await opener.cycle()).phase).toBe('restore-choice');
  await opener.service.chooseRestoreOption('apply-everywhere');
}

/** Écritures de `a` lues par `b`, puis accusés de `b` lus par `a`. */
export async function readByBoth(a: SimDevice, b: SimDevice): Promise<void> {
  await a.cycle();
  syncFolders([a, b]);
  await b.cycle();
  syncFolders([a, b]);
  await a.cycle();
  syncFolders([a, b]);
}

export const projectP = { id: P_ID, spaceId: PRO, name: 'P', color: '#123456' as HexColor, archived: false, sortOrder: 1 };

/** `count` tâches de B sous `projectId`, identifiants fixes (scénarios rejoués à l'identique). */
export function tasksUnder(projectId: ProjectId | null, count: number, prefix = '2') {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${String(i).padStart(7, '0')}-0000-4000-8000-000000000000` as TaskId,
    spaceId: PRO,
    projectId,
    title: `Tâche ${String(i)}`,
    note: '',
    date: DAY,
    time: null,
    status: 'todo' as const,
    doneAt: null,
    sortOrder: i,
    carriedOver: false,
    recurrenceId: null,
    seriesIndex: null,
    seriesTemplate: null,
    goalId: null,
    icon: null,
    someday: false,
    source: 'local' as const,
    externalId: null,
    appleListId: null,
    appleRecurring: false,
    externalEventId: null,
  }));
}

/** Lignes d'une table, sans `updated_at` (heure locale d'application). */
export const rowsOf = (device: SimDevice, table: string): Promise<unknown[]> =>
  device.driver.select(`SELECT * FROM ${table} ORDER BY id`).then((rows) => rows.map((row) => ({ ...(row as Record<string, unknown>), updated_at: null })));
