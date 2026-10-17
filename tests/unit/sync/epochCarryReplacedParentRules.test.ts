import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../../src/db/seed/defaultSpaces';
import type { HexColor, LocalDate, ProjectId, TaskId } from '../../../src/domain/types';
import type { RestoreMarker } from '../../../src/platform/sync/types';
import { setEpochSwitchTestHooks } from '../../../src/sync/epochSwitch';
import { PRO, createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-FIX-04 (B4) : règles voisines du report d'un enfant dont le parent a été remplacé : parent reporté avec l'enfant, y compris dans une
 * autre page de `reapply` (critère 4) ; parent à la corbeille dans la sauvegarde (critère 6, vérification 2 de la fiche) ; même espace
 * Pro / Perso (critère 8) ; journal sans contenu, notice jamais publiée (critères 11 et 12).
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const P_ID = '0f000000-0000-4000-8000-00000000000f' as ProjectId;
const Q_ID = '0f000000-0000-4000-8000-00000000001f' as ProjectId;
const DAY = '2026-10-05' as LocalDate;

let devices: SimDevice[] = [];
beforeAll(async () => {
  await warmSimDevices();
});
afterEach(async () => {
  setEpochSwitchTestHooks({});
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

async function two(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
  devices = [a, b];
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  syncFolders(devices);
  return [a, b];
}

async function rounds(n = 4): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    for (const d of devices) {
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

/** Écritures de A lues par B, puis accusés de B lus par A. */
async function readByBoth(a: SimDevice, b: SimDevice): Promise<void> {
  await a.cycle();
  syncFolders(devices);
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  syncFolders(devices);
}

const project = (id: ProjectId, spaceId = PRO) => ({ id, spaceId, name: `Projet ${String(id).slice(-2)}`, color: '#123456' as HexColor, archived: false, sortOrder: 1 });
const rowsOf = (device: SimDevice, table: string): Promise<unknown[]> =>
  device.driver.select(`SELECT * FROM ${table} ORDER BY id`).then((rows) => rows.map((row) => ({ ...(row as Record<string, unknown>), updated_at: null })));
const events = (device: SimDevice, name: string) => device.logger.entries.filter((e) => e.event === name);

describe('Y-FIX-04 : règles voisines du report d’un enfant de parent remplacé', () => {
  it('critère 4 : parent reporté avec l’enfant, dans une autre page de `reapply` : lien gardé, aucun rattachement', async () => {
    const [a, b] = await two();
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    // P et T créés par B, jamais lus par A ; 600 tâches de B placent T au-delà de la première page (500) de `sync_parked`.
    await b.data.repos.projects.create(project(P_ID));
    const filler = Array.from({ length: 600 }, (_, i) => ({
      id: `1${String(i).padStart(7, '0')}-0000-4000-8000-000000000000` as TaskId,
      spaceId: PRO,
      projectId: null,
      title: `Remplissage ${String(i)}`,
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
    await b.data.repos.tasks.createMany(filler);
    const t = await b.createTask('Sous P, reportée', { id: 'ffffffff-0000-4000-8000-000000000001' as TaskId, projectId: P_ID });
    await b.cycle();

    // Ordre de `sync_parked` après la matérialisation de B : le parent avant l'enfant, l'enfant au-delà de la première page.
    const parkedOrder: string[] = [];
    setEpochSwitchTestHooks({
      afterStep: async (step) => {
        if (step !== 'a' || parkedOrder.length > 0) return;
        const rows = await b.driver.select<{ row_id: string }>("SELECT row_id FROM sync_parked WHERE reason = 'epoch-carry' ORDER BY id");
        if (rows.some((row) => row.row_id === t.id)) for (const row of rows) parkedOrder.push(row.row_id);
      },
    });
    await applyEverywhere(a, copy);
    await rounds();
    expect(parkedOrder.indexOf(P_ID)).toBeGreaterThanOrEqual(0);
    expect(parkedOrder.indexOf(t.id)).toBeGreaterThan(parkedOrder.indexOf(P_ID));
    expect(parkedOrder.indexOf(t.id)).toBeGreaterThanOrEqual(500);
    for (const d of [a, b]) expect((await d.task(t.id))?.projectId, d.name).toBe(P_ID);
    expect(events(b, 'epoch-carry-reattached')).toEqual([]);
    expect(await rowsOf(a, 'project')).toEqual(await rowsOf(b, 'project'));
    expect((await rowsOf(a, 'task')).length).toBe((await rowsOf(b, 'task')).length);
  });

  it('critère 6 : parent à la corbeille dans la sauvegarde : tâche insérée sous lui, visible dans la journée chez A et B', async () => {
    const [a, b] = await two();
    await a.data.repos.projects.create(project(P_ID));
    await readByBoth(a, b);
    await a.data.repos.projects.softDelete(P_ID);
    await readByBoth(a, b);
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    const t = await b.createTask('Sous un projet supprimé', { projectId: P_ID });
    await b.cycle();
    await applyEverywhere(a, copy);
    await rounds();
    for (const d of [a, b]) {
      expect((await d.task(t.id))?.projectId, d.name).toBe(P_ID);
      expect((await d.data.repos.tasks.listForDay(DAY, 'all')).map((x) => x.id), d.name).toContain(t.id);
      expect((await d.data.repos.tasks.listForDay(DAY, PRO)).map((x) => x.id), d.name).toContain(t.id);
    }
    expect(events(b, 'epoch-carry-reattached')).toEqual([]);
  });

  it('critères 8, 11 et 12 : tâches Pro et Perso de projets remplacés : chacune garde son espace ; journal sans contenu ; notice locale', async () => {
    const [a, b] = await two();
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    await a.data.repos.projects.create(project(P_ID, PRO));
    await a.data.repos.projects.create(project(Q_ID, SPACE_PERSO_ID));
    await readByBoth(a, b);
    const pro = await b.createTask('Secret Pro', { projectId: P_ID });
    const perso = await b.createTask('Secret Perso', { projectId: Q_ID, spaceId: SPACE_PERSO_ID });
    await b.cycle();
    await applyEverywhere(a, copy);
    await rounds();
    for (const d of [a, b]) {
      expect((await d.task(pro.id))?.spaceId, d.name).toBe(PRO);
      expect((await d.task(perso.id))?.spaceId, d.name).toBe(SPACE_PERSO_ID);
      expect((await d.task(pro.id))?.projectId, d.name).toBeNull();
      expect((await d.task(perso.id))?.projectId, d.name).toBeNull();
      expect((await d.data.repos.tasks.listForDay(DAY, SPACE_PERSO_ID)).map((x) => x.id), d.name).toEqual([perso.id]);
      expect((await d.data.repos.tasks.listForDay(DAY, PRO)).map((x) => x.id), d.name).toEqual([pro.id]);
    }
    expect(events(b, 'epoch-carry-reattached').map((e) => e.detail)).toEqual([{ table: 'task', column: 'project_id', count: 2 }]);
    const journal = JSON.stringify([...a.logger.entries, ...b.logger.entries]);
    for (const secret of ['Secret Pro', 'Secret Perso', pro.id, perso.id]) expect(journal).not.toContain(secret);
    // Notice : locale à B (espaces et libellés), absente de A ; publiée nulle part (la clé n'est qu'une ligne de `sync_meta`).
    const notice = JSON.parse((await b.data.repos.sync.getMeta('epochCarryNotice')) ?? 'null') as { reattached: { rowId: string; space: string; label: string }[] };
    expect(notice.reattached.map((i) => [i.label, i.space]).sort()).toEqual([
      ['Secret Perso', SPACE_PERSO_ID],
      ['Secret Pro', PRO],
    ]);
    expect(await a.data.repos.sync.getMeta('epochCarryNotice')).toBeNull();
    expect(await rowsOf(a, 'task')).toEqual(await rowsOf(b, 'task'));
  });
});
