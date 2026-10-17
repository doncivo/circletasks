import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChecklistId, ChecklistItemId, HexColor, ProjectId } from '../../../src/domain/types';
import type { RestoreMarker } from '../../../src/platform/sync/types';
import { PRO, createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-FIX-04 (bloquant B4 de `docs/audit-1.0.md`) : report d'époque d'une ligne dont le parent a été **remplacé** par la restauration
 * « Appliquer partout ». L'ouvreur A avait lu le parent, absent de sa sauvegarde ; l'enfant, écrit par B, A ne l'avait jamais lu (ADR 0011
 * §24 point 6 : il doit survivre). Avant le correctif, `reapply` le rejouait avec `noPark` : ni appliqué, ni gardé, ni journalisé, puis
 * son report effacé ; il disparaissait des deux appareils.
 *
 * Critère 1 : tâche nouvelle sous un projet remplacé (lien facultatif : rattachée à « Sans projet » du même espace).
 * Critère 2 : tâche existante dont B change le titre et le projet (seul le lien vers le projet remplacé est perdu).
 * Critère 3 : élément de checklist sous une checklist remplacée (lien obligatoire : mis de côté `missing-parent`, appliqué au retour du parent).
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const P_ID = '0f000000-0000-4000-8000-00000000000f' as ProjectId;
const L_ID = '0c000000-0000-4000-8000-00000000000c' as ChecklistId;
const I_ID = '0d000000-0000-4000-8000-00000000000d' as ChecklistItemId;

let devices: SimDevice[] = [];
beforeAll(async () => {
  await warmSimDevices();
});
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

/** A (PC, ouvreur des restaurations) et B (iPhone) associés et synchronisés. */
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

/** Parent créé par A après la sauvegarde, lu par B, puis A lit en retour l'état de B (accusés) : le parent ne sera pas reporté. */
async function parentReadByBoth(a: SimDevice, b: SimDevice, create: () => Promise<unknown>): Promise<void> {
  await create();
  await a.cycle();
  syncFolders(devices);
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  syncFolders(devices);
}

const createProject = (device: SimDevice) => () => device.data.repos.projects.create({ id: P_ID, spaceId: PRO, name: 'P', color: '#123456' as HexColor, archived: false, sortOrder: 1 });
const rowsOf = (device: SimDevice, table: 'task' | 'project' | 'checklist' | 'checklist_item'): Promise<unknown[]> =>
  device.driver.select(`SELECT * FROM ${table} ORDER BY id`).then((rows) => rows.map((row) => ({ ...(row as Record<string, unknown>), updated_at: null })));
const events = (device: SimDevice, name: string) => device.logger.entries.filter((e) => e.event === name);

describe('Y-FIX-04 : report d’époque, parent remplacé par « Appliquer partout » (B4)', () => {
  it('critère 1 : tâche jamais lue par l’ouvreur sous un projet lu puis remplacé : rattachée à « Sans projet », jamais perdue', async () => {
    const [a, b] = await two();
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    await parentReadByBoth(a, b, createProject(a));
    const t = await b.createTask('Tâche sous P', { projectId: P_ID, note: 'Note de B' });
    await b.cycle();
    // Départ : P chez les deux, T chez B seulement (A ne lit jamais T avant d'ouvrir l'époque suivante).
    expect(await a.data.repos.projects.getById(P_ID)).not.toBeNull();
    expect(await b.data.repos.projects.getById(P_ID)).not.toBeNull();
    expect(await a.task(t.id)).toBeNull();
    expect((await b.task(t.id))?.projectId).toBe(P_ID);

    await applyEverywhere(a, copy);
    await rounds();

    // (a) survie de T chez A et chez B.
    const survived = { A: (await a.task(t.id))?.deletedAt === null, B: (await b.task(t.id))?.deletedAt === null };
    expect(survived, 'T attendue (non supprimée) chez A et chez B').toEqual({ A: true, B: true });
    // (b) « Sans projet », même espace, champs de B intacts.
    for (const d of [a, b]) {
      const row = await d.task(t.id);
      expect(row?.projectId, d.name).toBeNull();
      expect(row?.spaceId, d.name).toBe(PRO);
      expect(row?.title, d.name).toBe('Tâche sous P');
      expect(row?.note, d.name).toBe('Note de B');
    }
    // (c) P remplacé par la restauration (inchangé) ; (d) bases identiques.
    expect(await a.data.repos.projects.getById(P_ID, { includeDeleted: true })).toBeNull();
    expect(await b.data.repos.projects.getById(P_ID, { includeDeleted: true })).toBeNull();
    expect(await rowsOf(a, 'task')).toEqual(await rowsOf(b, 'task'));
    expect(await rowsOf(a, 'project')).toEqual(await rowsOf(b, 'project'));
    // (e) journal de B.
    expect(events(b, 'epoch-carry-reattached').map((e) => e.detail)).toEqual([{ table: 'task', column: 'project_id', count: 1 }]);
    expect(events(b, 'children-reattached').length).toBeGreaterThan(0);
    expect(events(b, 'apply-abandoned').filter((e) => e.detail['table'] === 'task')).toEqual([]);
    // (f) notice locale de B : nomme T.
    const notice = JSON.parse((await b.data.repos.sync.getMeta('epochCarryNotice')) ?? 'null') as { reattached: { rowId: string; label: string }[] } | null;
    expect(notice?.reattached.map((item) => [item.rowId, item.label])).toEqual([[t.id, 'Tâche sous P']]);
  });

  it('critère 2 : tâche présente dans la sauvegarde, titre et projet changés par B : titre gardé, lien vers le projet remplacé seul perdu', async () => {
    const [a, b] = await two();
    const t = await a.createTask('Titre de A');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    syncFolders(devices);
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    await parentReadByBoth(a, b, createProject(a));
    await b.updateTask(t.id, { title: 'Titre de B', projectId: P_ID });
    await b.cycle();
    expect((await a.task(t.id))?.title).toBe('Titre de A');

    await applyEverywhere(a, copy);
    await rounds();

    const titles = { A: (await a.task(t.id))?.title, B: (await b.task(t.id))?.title };
    expect(titles, 'écriture de B sur T attendue chez A et chez B').toEqual({ A: 'Titre de B', B: 'Titre de B' });
    for (const d of [a, b]) {
      const row = await d.task(t.id);
      expect(row?.projectId, d.name).toBeNull();
      expect(row?.spaceId, d.name).toBe(PRO);
      expect(row?.deletedAt, d.name).toBeNull();
    }
    expect(events(b, 'epoch-carry-reattached').map((e) => e.detail)).toEqual([{ table: 'task', column: 'project_id', count: 1 }]);
    expect(await rowsOf(a, 'task')).toEqual(await rowsOf(b, 'task'));
    expect(await rowsOf(a, 'project')).toEqual(await rowsOf(b, 'project'));
  });

  it('critère 3 : élément de checklist sous une checklist remplacée : mis de côté (`missing-parent`), appliqué quand la checklist revient', async () => {
    const [a, b] = await two();
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    const createChecklist = () => a.data.repos.checklists.create({ id: L_ID, spaceId: PRO, title: 'L', icon: null, date: null, isTemplate: false });
    await parentReadByBoth(a, b, createChecklist);
    expect(await b.data.repos.checklists.getById(L_ID)).not.toBeNull();
    await b.data.repos.checklistItems.add({ id: I_ID, checklistId: L_ID, text: 'Élément de B', checked: false, sortOrder: 1 });
    await b.cycle();
    expect(await a.data.repos.checklistItems.getByIds([I_ID])).toEqual([]);

    await applyEverywhere(a, copy);
    await rounds();

    const parked = async (d: SimDevice) => d.driver.select<{ reason: string; table_name: string; row_id: string; op: string }>('SELECT reason, table_name, row_id, op FROM sync_parked ORDER BY id');
    const held = (await parked(b)).filter((p) => p.reason === 'missing-parent' && p.table_name === 'checklist_item' && p.row_id === I_ID);
    expect(held.length, 'I attendu chez B (mis de côté, jamais effacé)').toBe(1);
    const op = JSON.parse((held[0] as { op: string }).op) as { f: Record<string, unknown[]> };
    expect(op.f['text']?.[0]).toBe('Élément de B');
    expect(op.f['checklist_id']?.[0]).toBe(L_ID);
    expect((await parked(b)).filter((p) => p.reason === 'epoch-carry')).toEqual([]);
    expect(events(b, 'epoch-carry-held').map((e) => e.detail)).toEqual([{ table: 'checklist_item', column: 'checklist_id', count: 1 }]);
    expect((await b.cycle()).warnings ?? []).toContain('carry-held');
    // Redémarrage, puis second cycle : toujours gardé tant que L manque.
    await b.restart();
    expect((await b.cycle()).warnings ?? []).toContain('carry-held');
    expect((await parked(b)).filter((p) => p.reason === 'missing-parent' && p.row_id === I_ID).length).toBe(1);

    // L revient (recréée par A avec le même identifiant) : I est appliqué sous L, puis republié jusqu'à A.
    await a.data.repos.checklists.create({ id: L_ID, spaceId: PRO, title: 'L recréée', icon: null, date: null, isTemplate: false });
    await rounds();
    expect((await parked(b)).filter((p) => p.row_id === I_ID)).toEqual([]);
    expect((await b.cycle()).warnings ?? []).not.toContain('carry-held');
    for (const d of [a, b]) expect((await d.data.repos.checklistItems.listForChecklist(L_ID)).map((i) => i.text), d.name).toEqual(['Élément de B']);
    expect(await rowsOf(a, 'checklist_item')).toEqual(await rowsOf(b, 'checklist_item'));
    expect(await rowsOf(a, 'checklist')).toEqual(await rowsOf(b, 'checklist'));
  });
});
