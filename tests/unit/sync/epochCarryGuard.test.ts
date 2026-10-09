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

/** Trois appareils associés au PC `a` (opener des restaurations), synchronisés. */
async function three(): Promise<[SimDevice, SimDevice, SimDevice]> {
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
  syncFolders(devices);
  return [a, b, c];
}

async function rounds(list: readonly SimDevice[], n = 3): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    for (const d of list) {
      await d.cycle();
      syncFolders(devices);
    }
  }
}

async function applyEverywhere(a: SimDevice, copy: Map<string, unknown[]>): Promise<void> {
  await restore(a, copy);
  expect((await a.cycle()).phase).toBe('restore-choice');
  await a.service.chooseRestoreOption('apply-everywhere');
}

/** Tableau du point 6 de l'ADR 0011 §24 : une ligne, un test. */
describe('tableau de la règle de report (ADR 0011 §24 point 6)', () => {
  it('tiers C lu une fois par l’ouvreur puis écrivant encore : survit (champ sur une ligne présente), double report idempotent, bases identiques', async () => {
    const [a, b, c] = await three();
    const t = await c.createTask('v1');
    await c.cycle();
    syncFolders(devices);
    await a.cycle();
    await b.cycle();
    syncFolders(devices);
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    // C réécrit (au-delà de ce que A a lu) ; B le lit ; A restaure et ouvre l'époque suivante.
    await c.updateTask(t.id, { title: 'v2' });
    await c.cycle();
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(t.id))?.title).toBe('v2');
    await applyEverywhere(a, copy);
    // B seul avec A : la mise à jour de C survit et arrive sur A (B la reporte, C silencieux).
    await rounds([a, b]);
    expect((await a.task(t.id))?.title).toBe('v2');
    expect((await b.task(t.id))?.title).toBe('v2');
    // C revient : il reporte le même champ (même hlc, même valeur) ; tout converge.
    await rounds([a, b, c], 4);
    for (const d of [a, b, c]) expect((await d.task(t.id))?.title, d.name).toBe('v2');
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(c));
  });

  it('écriture de C déjà lue par l’ouvreur : remplacée partout', async () => {
    const [a, b, c] = await three();
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    const readByA = await c.createTask('Écrite par C, lue par A');
    await c.cycle();
    syncFolders(devices);
    await a.cycle();
    await b.cycle();
    syncFolders(devices);
    expect((await a.task(readByA.id))?.title).toBe('Écrite par C, lue par A');
    await applyEverywhere(a, copy);
    await rounds([a, b, c], 4);
    for (const d of [a, b, c]) expect(await d.task(readByA.id), d.name).toBeNull();
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });

  it('écriture annulée de l’ouvreur (postérieure à la sauvegarde) : jamais reportée par les autres', async () => {
    const [a, b, c] = await three();
    const t = await a.createTask('Version sauvegardée');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    await c.cycle();
    syncFolders(devices);
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    await a.updateTask(t.id, { title: 'Annulée par la restauration' });
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    await c.cycle();
    syncFolders(devices);
    await applyEverywhere(a, copy);
    await rounds([a, b, c], 4);
    for (const d of [a, b, c]) expect((await d.task(t.id))?.title, d.name).toBe('Version sauvegardée');
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(c));
  });
});
