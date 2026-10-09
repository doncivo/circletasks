import { afterEach, describe, expect, it } from 'vitest';
import type { RestoreMarker } from '../../../src/platform/sync/types';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-IOS-02 (point de contrôle 0.2.3) : garde générale d'un changement d'époque (ADR 0011 §9.1 (a)). Une ligne qu'un appareil détient,
 * écrite par un **troisième** appareil que l'ouvreur n'avait jamais lu, absente de l'instantané d'ouverture, n'est pas perdue : elle est
 * reportée, recréée entière et republiée. Ce que l'ouvreur avait lu reste remplacé (règle de la restauration, test `restore.test.ts`).
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function backupOf(device: SimDevice): Promise<Map<string, unknown[]>> {
  const tables = await device.driver.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_index%' AND name NOT LIKE 'sqlite_%'");
  const copy = new Map<string, unknown[]>();
  for (const { name } of tables) copy.set(name, await device.driver.select(`SELECT * FROM ${name}`));
  return copy;
}

async function restore(device: SimDevice, copy: Map<string, unknown[]>): Promise<void> {
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

describe('garde générale du changement d’époque', () => {
  it('ligne écrite par un troisième appareil jamais lu par l’ouvreur : gardée par B et republiée, jamais perdue', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
    const c = await createSimDevice(C_ID, { name: 'Autre', clock: a.clock });
    devices = [a, b, c];
    await setupFirst(a);
    await a.cycle();
    await pair(a, b);
    await pair(a, c);
    await b.cycle();
    await c.cycle();
    syncFolders(devices);
    await a.cycle();
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    // C écrit une ligne ; B la lit ; A ne lit jamais C avant d'ouvrir l'époque suivante.
    const fromC = await c.createTask('Écrite par C');
    await c.cycle();
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(fromC.id))?.title).toBe('Écrite par C');
    await restore(a, copy);
    expect((await a.cycle()).phase).toBe('restore-choice');
    await a.service.chooseRestoreOption('apply-everywhere');
    // Seuls A et B se parlent ensuite : C ne republie rien.
    syncFolders([a, b]);
    await b.cycle();
    syncFolders([a, b]);
    await a.cycle();
    syncFolders([a, b]);
    await b.cycle();
    expect((await b.task(fromC.id))?.title).toBe('Écrite par C');
    expect((await a.task(fromC.id))?.title).toBe('Écrite par C');
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});
