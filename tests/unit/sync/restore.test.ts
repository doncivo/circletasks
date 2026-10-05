import { afterEach, describe, expect, it, vi } from 'vitest';
import { setEpochSwitchTestHooks } from '../../../src/sync/epochSwitch';
import type { RestoreMarker } from '../../../src/platform/sync/types';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';
// Simulation à deux bases SQLite Wasm : marge pour une machine chargée (plusieurs lots en parallèle).
vi.setConfig({ testTimeout: 30_000 });

/**
 * Restauration P-04 et changements d'époque (ADR 0010, ADR 0011 sections 9 et 9.1 ; Y-02 critères 13 à 15, Y-09 critères 8 et 9).
 * « Restaurer » est simulé comme P-04 : la base de l'appareil revient à une copie antérieure (sauvegarde SQLite), le dossier, le coffre
 * et own.json (Rust) sont gardés, et le marqueur est posé.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
afterEach(async () => {
  setEpochSwitchTestHooks({});
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
  devices = [a, b];
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  return [a, b];
}

/** Copie de la base (comme une sauvegarde P-04) : toutes les tables, lignes comprises. */
async function backupOf(device: SimDevice): Promise<Map<string, unknown[]>> {
  const tables = await device.driver.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_index%' AND name NOT LIKE 'sqlite_%'");
  const copy = new Map<string, unknown[]>();
  for (const { name } of tables) copy.set(name, await device.driver.select(`SELECT * FROM ${name}`));
  return copy;
}

/** Restauration de la copie dans la base de l'appareil (sans déclencheur : comme un échange de fichiers), puis marqueur. */
async function restore(device: SimDevice, copy: Map<string, unknown[]>, backupTakenAt: string): Promise<void> {
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
  const marker: RestoreMarker = { backup: 'circletasks-daily-20261005.db', backupTakenAt: backupTakenAt as RestoreMarker['backupTakenAt'], restoredAt: new Date(device.clock.nowMs()).toISOString() as RestoreMarker['restoredAt'], schemaVersion: 17 };
  device.platform.testing.setRestoreMarker(marker);
  await device.restart();
}

describe('restauration P-04 (Y-02 critères 13 à 15)', () => {
  it('marqueur : aucun cycle (ni lecture ni publication), phase restore-choice, deux options', async () => {
    const [a] = await twoDevices();
    const copy = await backupOf(a);
    const before = a.folder.fileNames(A_ID);
    await restore(a, copy, '2026-10-05T07:00:00.000Z');
    await a.createTask('Après restauration');
    const status = await a.cycle();
    expect(status.phase).toBe('restore-choice');
    expect(a.folder.fileNames(A_ID)).toEqual(before);
    expect((await a.service.restoreContext())?.options).toEqual(['apply-everywhere', 'keep-synced']);
  });

  it('« Appliquer partout » : époque n+1 ; B garde ce que A n’avait jamais lu et ses écritures non publiées, perd ce que A avait lu', async () => {
    const [a, b] = await twoDevices();
    const t1 = await a.createTask('Version sauvegardée');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    // A modifie t1 après la sauvegarde (cette écriture sera annulée partout).
    await a.updateTask(t1.id, { title: 'Après la sauvegarde (A)' });
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    // B : une écriture que A a lue (lue par A au cycle suivant), puis une écriture publiée jamais lue par A, puis une non publiée.
    const readByA = await b.createTask('B lue par A');
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    syncFolders(devices);
    const unread = await b.createTask('B jamais lue par A');
    await b.cycle();
    await restore(a, copy, '2026-10-05T07:00:00.000Z');
    expect((await a.cycle()).phase).toBe('restore-choice');
    await a.service.chooseRestoreOption('apply-everywhere');
    expect(a.service.status().phase).toBe('idle');
    expect(a.logger.entries.some((e) => e.event === 'restore-applied-everywhere')).toBe(true);
    const unpublished = await b.createTask('B non publiée');
    syncFolders(devices);
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    for (const d of devices) {
      expect((await d.task(t1.id))?.title, d.name).toBe('Version sauvegardée');
      expect(await d.task(readByA.id), d.name).toBeNull();
      expect((await d.task(unread.id))?.title, d.name).toBe('B jamais lue par A');
      expect((await d.task(unpublished.id))?.title, d.name).toBe('B non publiée');
    }
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    // Règle 1 : stateSeq ne repart jamais à 1 ; le marqueur est effacé.
    expect(await a.platform.restoreMarker.get()).toBeNull();
    const epochs = a.folder.fileNames(A_ID).filter((n) => n.startsWith('e0002-'));
    expect(epochs.length).toBeGreaterThan(0);
  });

  it('« Garder les données synchronisées » : reprise en fusion, rien n’est perdu, le marqueur est effacé', async () => {
    const [a, b] = await twoDevices();
    const t1 = await a.createTask('Avant');
    await a.cycle();
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    const t2 = await a.createTask('Après la sauvegarde');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    await restore(a, copy, '2026-10-05T07:00:00.000Z');
    await a.service.chooseRestoreOption('keep-synced');
    expect(await a.platform.restoreMarker.get()).toBeNull();
    // A retrouve sa propre écriture postérieure à la sauvegarde (lue dans son journal) et B n'a rien perdu.
    expect((await a.task(t2.id))?.title).toBe('Après la sauvegarde');
    expect((await a.task(t1.id))?.title).toBe('Avant');
    const next = await a.createTask('Encore');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(next.id))?.title).toBe('Encore');
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });

  it('règle 4 : sauvegarde antérieure à une suppression déjà purgée : seule « Appliquer partout » est proposée', async () => {
    const [a] = await twoDevices();
    const copy = await backupOf(a);
    await restore(a, copy, '2026-01-01T00:00:00.000Z');
    await a.data.repos.sync.setMeta('purgeHorizon', JSON.stringify(`001791187200000-0000-${B_ID}`));
    expect((await a.service.restoreContext())?.options).toEqual(['apply-everywhere']);
    await a.service.chooseRestoreOption('keep-synced');
    expect(await a.platform.restoreMarker.get()).not.toBeNull();
  });
});

describe('changement d’époque sans perte (section 9.1)', () => {
  it('arrêt simulé après chaque étape (a, b, c) : la reprise termine sans perte', async () => {
    for (const step of ['a', 'b', 'c'] as const) {
      const [a, b] = await twoDevices();
      const copy = await backupOf(a);
      const mine = await b.createTask(`B publiée ${step}`);
      await b.cycle();
      const pending = await b.createTask(`B en attente ${step}`);
      await restore(a, copy, '2026-10-05T07:00:00.000Z');
      await a.service.chooseRestoreOption('apply-everywhere');
      syncFolders(devices);
      setEpochSwitchTestHooks({
        afterStep: (done) => {
          if (done === step) throw new Error('arrêt simulé');
        },
      });
      await b.cycle();
      setEpochSwitchTestHooks({});
      await b.restart();
      await b.cycle();
      syncFolders(devices);
      await a.cycle();
      for (const d of devices) {
        expect((await d.task(mine.id))?.title, `${step} ${d.name}`).toBe(`B publiée ${step}`);
        expect((await d.task(pending.id))?.title, `${step} ${d.name}`).toBe(`B en attente ${step}`);
      }
      await Promise.all(devices.map((d) => d.close()));
      devices = [];
    }
  });

  it('époques concurrentes : la plus grande l’emporte, les écritures publiées dans l’époque perdante sont reportées', async () => {
    const [a, b] = await twoDevices();
    const copyA = await backupOf(a);
    const copyB = await backupOf(b);
    await restore(a, copyA, '2026-10-05T07:00:00.000Z');
    await restore(b, copyB, '2026-10-05T07:00:00.000Z');
    await a.service.chooseRestoreOption('apply-everywhere');
    await b.service.chooseRestoreOption('apply-everywhere');
    // B (UUID plus grand) gagne ; A publie une écriture dans son époque perdante avant de voir celle de B.
    const lost = await a.createTask('Écrite dans l’époque perdante');
    await a.cycle();
    syncFolders(devices);
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    expect(a.logger.entries.some((e) => e.event === 'epoch-switched' && String(e.detail['target']).endsWith(B_ID))).toBe(true);
    for (const d of devices) expect((await d.task(lost.id))?.title, d.name).toBe('Écrite dans l’époque perdante');
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});
