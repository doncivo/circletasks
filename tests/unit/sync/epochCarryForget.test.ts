import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceId } from '../../../src/domain/types';
import type { RestoreMarker } from '../../../src/platform/sync/types';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';

/**
 * ADR 0011 §24 point 6 (tableau du report d'époque), lignes « appareil oublié », « oubli annulé » et « époque concurrente à `covers` vide ».
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const X_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const Y_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

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

async function applyEverywhere(a: SimDevice, copy: Map<string, unknown[]>): Promise<void> {
  await restore(a, copy);
  expect((await a.cycle()).phase).toBe('restore-choice');
  await a.service.chooseRestoreOption('apply-everywhere');
}

async function join(owner: SimDevice, id: string, name: string): Promise<SimDevice> {
  const d = await createSimDevice(id, { name, clock: owner.clock });
  devices.push(d);
  // Fenêtre de confirmation native : au plus quelques associations par intervalle.
  owner.clock.advance(11 * 60_000);
  await pair(owner, d);
  await d.cycle();
  return d;
}

async function settle(list: readonly SimDevice[], rounds = 3): Promise<void> {
  for (let r = 0; r < rounds; r += 1) {
    for (const d of list) {
      syncFolders(list as SimDevice[]);
      d.clock.advance(1_000);
      await d.cycle();
    }
  }
}

const titles = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ title: string }>('SELECT title FROM task WHERE deleted_at IS NULL ORDER BY title')).map((r) => r.title);

describe('tableau de la règle de report (ADR 0011 §24 point 6), suite', () => {
  it('appareil oublié : ses écritures au-delà de covers[X] ne sont reportées par personne', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    devices = [a];
    await setupFirst(a);
    await a.cycle();
    const b = await join(a, B_ID, 'iPhone');
    const c = await join(a, C_ID, 'Autre');
    await settle([a, b, c]);
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    // C écrit ; B le lit puis oublie C ; A n'a jamais lu C avant de restaurer.
    await c.createTask('Écrite par C');
    await c.cycle();
    syncFolders([b, c]);
    await b.cycle();
    expect(await titles(b)).toEqual(['Écrite par C']);
    expect(await b.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await applyEverywhere(a, copy);
    await settle([a, b], 4);
    expect(await titles(a)).toEqual([]);
    expect(await titles(b)).toEqual([]);
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });

  it('oubli annulé : l’appareil redevient actif et ses écritures au-delà de covers sont reportées comme celles des autres', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    devices = [a];
    await setupFirst(a);
    await a.cycle();
    const b = await join(a, B_ID, 'iPhone');
    const c = await join(a, C_ID, 'Autre');
    const x = await join(a, X_ID, 'Second PC');
    const y = await join(a, Y_ID, 'Ouvreur');
    await settle([a, b, c, x, y]);
    const copy = await backupOf(y);
    y.clock.advance(60_000);
    // X oublie A hors ligne ; plus tard A oublie C ; C écrit au-delà de la coupure ; la déclaration de X annule celle de A : C redevient actif.
    expect(await x.service.forgetDevice(a.id as DeviceId)).toEqual({ kind: 'done' });
    a.clock.advance(5_000);
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b]);
    await c.createTask('Écrite par C');
    await c.cycle();
    await settle([a, b]);
    await settle([b, x, c]);
    expect(await titles(b)).toEqual(['Écrite par C']);
    // Y (hors ligne depuis le début : il n'a jamais lu cette écriture) restaure et applique partout : B et X la reportent, C étant
    // redevenu actif.
    await applyEverywhere(y, copy);
    await settle([y, b, x], 4);
    for (const d of [y, b, x]) expect(await titles(d), d.name).toEqual(['Écrite par C']);
    expect(await taskSnapshot(y)).toEqual(await taskSnapshot(b));
  });

  it('époque concurrente à covers vide : l’ouvreur n’a rien lu, chaque détenteur reporte tout, rien n’est effacé et les bases sont identiques', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    devices = [a];
    await setupFirst(a);
    await a.cycle();
    const copy = await backupOf(a);
    const b = await join(a, B_ID, 'iPhone');
    const c = await join(a, C_ID, 'Autre');
    await settle([a, b, c]);
    await b.createTask('Écrite par B');
    await c.createTask('Écrite par C');
    await b.cycle();
    await c.cycle();
    syncFolders([a, b, c]);
    await settle([b, c]);
    expect(await titles(b)).toEqual(['Écrite par B', 'Écrite par C']);
    // A n'a rien lu de B ni de C (aucun cycle) : sa base de départ est vide, ses `covers` n'ont aucune position sur B et C.
    await applyEverywhere(a, copy);
    await settle([a, b, c], 5);
    for (const d of [a, b, c]) expect(await titles(d), d.name).toEqual(['Écrite par B', 'Écrite par C']);
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(c));
  });
});
