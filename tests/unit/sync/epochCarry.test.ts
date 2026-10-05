import { afterEach, describe, expect, it } from 'vitest';
import type { RestoreMarker } from '../../../src/platform/sync/types';
import { setEpochSwitchTestHooks } from '../../../src/sync/epochSwitch';
import { propagate } from '../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';

/**
 * Changement d'époque sans perte (ADR 0011 section 9.1 ; Y-02 critère 14 ; revue Y2 points 3 et 13) : une écriture locale faite pendant
 * le changement n'est ni écrasée par le remplacement ni oubliée par le vidage de la file ; une ligne recréée par le report est republiée
 * entière (champs des autres appareils compris).
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

describe('changement d’époque : écritures pendant le changement (revue Y2, point 3)', () => {
  it('une modification et une création locales faites entre (a) et (b) sont gardées, publiées et reçues par A', async () => {
    const [a, b] = await twoDevices();
    const shared = await a.createTask('Partagée');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    const copy = await backupOf(a);
    await restore(a, copy);
    await a.service.chooseRestoreOption('apply-everywhere');
    syncFolders(devices);
    let created: string | null = null;
    setEpochSwitchTestHooks({
      afterStep: async (step) => {
        if (step !== 'a') return;
        b.clock.advance(1_000);
        await b.updateTask(shared.id, { title: 'Modifiée pendant le changement' });
        created = (await b.createTask('Créée pendant le changement')).id;
      },
    });
    await b.cycle();
    setEpochSwitchTestHooks({});
    expect(b.logger.entries.some((e) => e.event === 'epoch-switched')).toBe(true);
    expect((await b.task(shared.id))?.title).toBe('Modifiée pendant le changement');
    expect((await b.task(created as never))?.title).toBe('Créée pendant le changement');
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    expect((await a.task(shared.id))?.title).toBe('Modifiée pendant le changement');
    expect((await a.task(created as never))?.title).toBe('Créée pendant le changement');
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});

describe('changement d’époque : ligne recréée par le report (revue Y2, point 13)', () => {
  it('une tâche de A absente de la version restaurée, modifiée par B : recréée chez B et republiée entière, A la reçoit complète', async () => {
    const [a, b] = await twoDevices();
    const copy = await backupOf(a);
    a.clock.advance(1_000);
    const t = await a.createTask('Créée par A après la sauvegarde');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    // B modifie la note, sans que A ne le lise avant de restaurer.
    a.clock.advance(1_000);
    await b.updateTask(t.id, { note: 'note de B' });
    await b.cycle();
    await restore(a, copy);
    await a.service.chooseRestoreOption('apply-everywhere');
    expect(await a.task(t.id)).toBeNull();
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(t.id))?.title).toBe('Créée par A après la sauvegarde');
    syncFolders(devices);
    await a.cycle();
    const onA = await a.task(t.id);
    expect(onA?.title).toBe('Créée par A après la sauvegarde');
    expect(onA?.note).toBe('note de B');
    expect(await a.driver.select("SELECT reason FROM sync_parked WHERE row_id = ?", [t.id])).toEqual([]);
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});

describe('opération découpée (plus de 256 Kio) : accusé jamais au milieu d’un groupe de même hlc (revue finale Y2, point 4)', () => {
  const note = '€'.repeat(85_000);
  const title = '€'.repeat(4_000);

  it('page coupée entre deux parties : accusé et curseur inchangés ; complet au cycle suivant', async () => {
    const [a, b] = await twoDevices();
    const before = (await a.driver.select<{ ack_hlc: string | null; cursor_segment: number; cursor_record: number }>('SELECT ack_hlc, cursor_segment, cursor_record FROM sync_state WHERE device_id = ?', [B_ID]))[0];
    a.clock.advance(1_000);
    const big = await b.createTask(title, { note });
    await b.cycle();
    expect(b.folder.fileNames(B_ID).length).toBeGreaterThan(0);
    // La dernière partie n'est pas encore arrivée chez A.
    propagate(b.folder, a.folder, B_ID, { partialLastLine: true });
    expect((await a.cycle()).phase).toBe('waiting-icloud');
    const cut = (await a.driver.select<{ ack_hlc: string | null; cursor_segment: number; cursor_record: number }>('SELECT ack_hlc, cursor_segment, cursor_record FROM sync_state WHERE device_id = ?', [B_ID]))[0];
    expect(cut).toEqual(before);
    expect(cut?.ack_hlc === null || (cut?.ack_hlc ?? '') < big.hlc).toBe(true);
    propagate(b.folder, a.folder, B_ID);
    expect((await a.cycle()).phase).toBe('idle');
    const row = await a.task(big.id);
    expect(row?.note).toBe(note);
    expect(row?.title).toBe(title);
    const after = (await a.driver.select<{ ack_hlc: string }>('SELECT ack_hlc FROM sync_state WHERE device_id = ?', [B_ID]))[0];
    expect(after?.ack_hlc).toBe(big.hlc);
  });

  it('« Appliquer partout » après une lecture coupée au milieu du groupe : la ligne découpée de B n’est pas perdue', async () => {
    const [a, b] = await twoDevices();
    const copy = await backupOf(a);
    a.clock.advance(1_000);
    const big = await b.createTask(title, { note });
    await b.cycle();
    propagate(b.folder, a.folder, B_ID, { partialLastLine: true });
    await a.cycle();
    // A restaure sa sauvegarde et l'applique partout : covers[B] vient de ce que A a accusé de B.
    await restore(a, copy);
    await a.service.chooseRestoreOption('apply-everywhere');
    syncFolders(devices);
    await b.cycle();
    expect(b.logger.entries.some((e) => e.event === 'epoch-switched')).toBe(true);
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    for (const d of devices) {
      const row = await d.task(big.id);
      expect(row?.title, d.name).toBe(title);
      expect(row?.note, d.name).toBe(note);
    }
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});
