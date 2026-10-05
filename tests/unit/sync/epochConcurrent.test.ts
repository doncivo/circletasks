import { afterEach, describe, expect, it } from 'vitest';
import type { RestoreMarker } from '../../../src/platform/sync/types';
import { setEpochSwitchTestHooks, type SwitchStep } from '../../../src/sync/epochSwitch';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';

/**
 * Changement d'époque avec écritures concurrentes, restauration avec modifications jamais lues de l'autre appareil (ADR 0010, ADR 0011
 * sections 9 et 9.1 ; Y-02 critères 13, 14 et 15, Y-09 critère 9). Les écritures « pendant » le changement sont faites par le crochet
 * `afterStep` de `epochSwitch` : l'événement réel (la fin d'une étape), aucun délai.
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

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    for (const d of devices) await d.cycle();
    syncFolders(devices);
  }
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

describe('changement d’époque : écritures de l’appareil pendant chaque étape (Y-02 critère 14)', () => {
  it.each<SwitchStep>(['a', 'b', 'c'])('écriture locale (modification, création, suppression) juste après l’étape (%s) : gardée, publiée, reçue par l’ouvreur', async (step) => {
    const [a, b] = await twoDevices();
    const shared = await a.createTask('Partagée');
    const doomed = await a.createTask('À supprimer pendant le changement');
    await settle();
    const copy = await backupOf(a);
    await restore(a, copy);
    await a.service.chooseRestoreOption('apply-everywhere');
    syncFolders(devices);
    let created: string | null = null;
    setEpochSwitchTestHooks({
      afterStep: async (done) => {
        if (done !== step) return;
        b.clock.advance(1_000);
        await b.updateTask(shared.id, { title: `Modifiée après l’étape ${step}` });
        created = (await b.createTask(`Créée après l’étape ${step}`)).id;
        await b.deleteTask(doomed.id);
      },
    });
    await b.cycle();
    setEpochSwitchTestHooks({});
    expect(b.logger.entries.some((e) => e.event === 'epoch-switched')).toBe(true);
    await settle();
    for (const d of devices) {
      expect((await d.task(shared.id))?.title, d.name).toBe(`Modifiée après l’étape ${step}`);
      expect((await d.task(created as never))?.title, d.name).toBe(`Créée après l’étape ${step}`);
      expect((await d.task(doomed.id))?.deletedAt, d.name).not.toBeNull();
      expect(await d.data.repos.sync.outboxCount(), d.name).toBe(0);
      expect(await d.driver.select("SELECT * FROM sync_parked WHERE reason = 'epoch-carry'"), d.name).toEqual([]);
    }
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });

  it('arrêt brutal après l’étape (b) avec une écriture locale entre (b) et (c) : reprise à l’étape (c), écriture gardée', async () => {
    const [a, b] = await twoDevices();
    const shared = await a.createTask('Partagée');
    await settle();
    const copy = await backupOf(a);
    await restore(a, copy);
    await a.service.chooseRestoreOption('apply-everywhere');
    syncFolders(devices);
    setEpochSwitchTestHooks({
      afterStep: async (done) => {
        if (done !== 'b') return;
        b.clock.advance(1_000);
        await b.updateTask(shared.id, { note: 'écrite avant l’arrêt' });
        throw new Error('arrêt simulé');
      },
    });
    await b.cycle();
    setEpochSwitchTestHooks({});
    await b.restart();
    await settle();
    for (const d of devices) expect((await d.task(shared.id))?.note, d.name).toBe('écrite avant l’arrêt');
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});

describe('restauration : modifications jamais lues de l’autre appareil (Y-02 critère 14, règle confirmée par Ali)', () => {
  /** Ligne dont deux champs ont des hlc différents : le titre a été lu par A, la note ne l'a jamais été. */
  async function scenario(): Promise<{ a: SimDevice; b: SimDevice; id: string; copy: Map<string, unknown[]> }> {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Titre v0', { note: 'note v0' });
    await settle();
    const copy = await backupOf(a);
    b.clock.advance(1_000);
    await b.updateTask(t.id, { title: 'Titre de B lu par A' });
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    syncFolders(devices);
    b.clock.advance(1_000);
    await b.updateTask(t.id, { note: 'note de B jamais lue par A' });
    await b.cycle();
    return { a, b, id: t.id, copy };
  }

  it('« Appliquer partout » : le champ lu par l’appareil restauré revient à la sauvegarde, le champ jamais lu est gardé, sur les deux appareils', async () => {
    const { a, b, id, copy } = await scenario();
    await restore(a, copy);
    await a.service.chooseRestoreOption('apply-everywhere');
    await settle();
    for (const d of devices) {
      const row = await d.task(id as never);
      expect(row?.title, `${d.name} : titre lu par A, remplacé`).toBe('Titre v0');
      expect(row?.note, `${d.name} : note jamais lue par A, gardée`).toBe('note de B jamais lue par A');
    }
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });

  it('« Garder les données synchronisées » : les deux modifications de B sont gardées, la sauvegarde ne les efface pas', async () => {
    const { a, b, id, copy } = await scenario();
    await restore(a, copy);
    await a.service.chooseRestoreOption('keep-synced');
    await settle();
    for (const d of devices) {
      const row = await d.task(id as never);
      expect(row?.title, d.name).toBe('Titre de B lu par A');
      expect(row?.note, d.name).toBe('note de B jamais lue par A');
    }
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});

describe('deux changements d’époque rapprochés (Y-02 critères 14 et 15)', () => {
  it('A restaure deux fois avant que B ne cycle : B passe directement à la dernière époque, garde ce que A n’a jamais lu et ses écritures non publiées', async () => {
    const [a, b] = await twoDevices();
    const base = await a.createTask('Base');
    await settle();
    const copy = await backupOf(a);
    a.clock.advance(1_000);
    const lostByRestore = await a.createTask('Écrite par A après la sauvegarde');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    b.clock.advance(1_000);
    const published = await b.createTask('B publiée jamais lue');
    await b.cycle();
    const pending = await b.createTask('B non publiée');
    await b.updateTask(base.id, { note: 'note de B non publiée' });
    // Première restauration, puis nouvelle écriture de A, puis seconde restauration : e0002 puis e0003, sans que B ne voie e0002.
    await restore(a, copy);
    await a.service.chooseRestoreOption('apply-everywhere');
    a.clock.advance(1_000);
    await a.createTask('Écrite entre les deux restaurations');
    await a.cycle();
    await restore(a, copy);
    await a.service.chooseRestoreOption('apply-everywhere');
    syncFolders(devices);
    await settle();
    expect(b.logger.entries.filter((e) => e.event === 'epoch-switched').length).toBeGreaterThan(0);
    expect(String(await b.data.repos.sync.getMeta('epoch'))).toContain('e0003-');
    for (const d of devices) {
      expect((await d.task(base.id))?.note, d.name).toBe('note de B non publiée');
      expect((await d.task(published.id))?.title, d.name).toBe('B publiée jamais lue');
      expect((await d.task(pending.id))?.title, d.name).toBe('B non publiée');
      expect(await d.task(lostByRestore.id), `${d.name} : écriture de A déjà lue, remplacée`).toBeNull();
      expect(await d.data.repos.sync.outboxCount(), d.name).toBe(0);
    }
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});
