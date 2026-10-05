import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../../../src/db/driver';
import type { SyncValue } from '../../../../src/domain/sync/format';
import type { TaskId } from '../../../../src/domain/types';
import { OTHER, PRO, SELF, STAMP_AT, STAMP_DEVICE, STAMP_HLC, openConflictBench, otherHlc, type ConflictBench } from './kit';

/**
 * QA de Y-04 (critères 5 à 10) : cas limites de la restauration que les tests de l'auteur ne couvrent pas. Parent à la corbeille, ligne
 * à la corbeille, double clic, annulation après une saisie dans un autre champ, échec de l'annulation, atomicité de la restauration d'un
 * élément (tâche et rappels), tâche sortie de la fenêtre de la corbeille, valeurs de chaque type (valides et falsifiées), identifiants
 * hostiles. Aucun délai : horloge manuelle.
 */

let bench: ConflictBench;

beforeEach(async () => {
  bench = await openConflictBench();
});

afterEach(async () => {
  await bench.close();
});

const outbox = (table: string, id: string) => bench.select<{ field: string }>('SELECT field FROM sync_outbox WHERE table_name = ? AND row_id = ? ORDER BY field', [table, id]);
const conflictRow = async (id: number) => (await bench.select<{ restored: number; resolved_at: string | null }>('SELECT restored, resolved_at FROM conflict_log WHERE id = ?', [id]))[0];
const published = () => bench.driver.execute('DELETE FROM sync_outbox');

async function project(id: string, deleted = false): Promise<string> {
  await bench.stamped("INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Clients', '#2f6b7a', 1, ?, ?, ?, ?)", [id, PRO, STAMP_AT, STAMP_AT, STAMP_DEVICE, STAMP_HLC]);
  if (deleted) {
    bench.clock.advance(10);
    await bench.stamped('UPDATE project SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ?', [new Date(bench.clock.nowMs()).toISOString(), STAMP_AT, STAMP_DEVICE, STAMP_HLC, id]);
  }
  return id;
}

/** Fait échouer, dans la transaction de la restauration, toute écriture dont le SQL correspond. */
function failWrites(pattern: RegExp): () => void {
  const real = bench.driver.transaction.bind(bench.driver);
  bench.driver.transaction = ((fn: (tx: SqlExecutor) => Promise<unknown>) =>
    real((tx) =>
      fn({
        select: (sql, params) => tx.select(sql, params),
        execute: (sql, params) => (pattern.test(sql) ? Promise.reject(new Error('panne simulée')) : tx.execute(sql, params)),
      }),
    )) as typeof bench.driver.transaction;
  return () => {
    bench.driver.transaction = real as typeof bench.driver.transaction;
  };
}

async function timeConflict(): Promise<{ taskId: TaskId; conflictId: number }> {
  const task = await bench.createTask('Envoyer la facture', { time: '09:00' as never });
  await published();
  bench.clock.advance(1_000);
  const conflictId = await bench.conflict({ table: 'task', rowId: task.id, field: 'time', kept: '09:00', discarded: '10:00', keptHlc: otherHlc(500), discardedHlc: otherHlc(400, SELF) });
  return { taskId: task.id, conflictId };
}

describe('Y-04 critère 8 : refus (compléments de la QA)', () => {
  it('Y-04 critère 8 : valeur qui désigne un projet à la corbeille : refus « L’élément lié n’existe plus », rien d’écrit', async () => {
    const trashed = await project('40000000-0000-4000-8000-0000000000aa', true);
    const task = await bench.createTask('Relancer');
    await published();
    const id = await bench.conflict({ table: 'task', rowId: task.id, field: 'project_id', kept: null, discarded: trashed });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'refused', reason: 'parent-gone' });
    expect(await outbox('task', task.id)).toEqual([]);
    expect((await bench.data.repos.tasks.getById(task.id))?.projectId).toBeNull();
    expect((await bench.useCases.list(1)).items[0]?.blocked).toBe('parent-gone');
  });

  it('Y-04 critère 8 : valeur qui désigne un projet vivant : restaurée (le refus ne dépend pas du type de la colonne seule)', async () => {
    const live = await project('40000000-0000-4000-8000-0000000000bb');
    const task = await bench.createTask('Relancer');
    await published();
    const id = await bench.conflict({ table: 'task', rowId: task.id, field: 'project_id', kept: null, discarded: live });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'restored' });
    expect((await bench.data.repos.tasks.getById(task.id))?.projectId).toBe(live);
    expect((await bench.useCases.list(1)).items[0]).toMatchObject({ restored: true, blocked: null });
  });

  it('Y-04 critère 8 : ligne à la corbeille, champ ordinaire : la valeur est écrite dans la ligne supprimée, la tâche n’est pas ressuscitée', async () => {
    const task = await bench.createTask('À la corbeille', { note: 'a' });
    bench.clock.advance(1_000);
    await bench.data.repos.tasks.softDelete([task.id]);
    await published();
    const id = await bench.conflict({ table: 'task', rowId: task.id, field: 'note', kept: 'a', discarded: 'b' });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'restored' });
    const row = await bench.data.repos.tasks.getById(task.id, { includeDeleted: true });
    expect(row?.note).toBe('b');
    expect(row?.deletedAt).not.toBeNull();
    expect(bench.taskEntities.get(task.id)).toBeUndefined();
  });

  it('Y-04 critère 8 : aucun refus ne laisse une trace dans la pile d’annulation ni dans la file', async () => {
    const gone = await bench.conflict({ table: 'task', rowId: '33333333-3333-4333-8333-333333333333', field: 'title', kept: 'A', discarded: 'B' });
    expect(await bench.useCases.restore(gone)).toMatchObject({ status: 'refused' });
    expect(await bench.useCases.restore(987_654)).toEqual({ status: 'refused', reason: 'row-gone' });
    expect(bench.undo.getSnapshot().size).toBe(0);
    expect(await bench.select('SELECT COUNT(*) AS n FROM sync_outbox')).toEqual([{ n: 0 }]);
  });
});

describe('Y-04 critère 5 : une seule transaction (compléments de la QA)', () => {
  it('Y-04 critère 5 : deux « Restaurer » simultanés (double clic) : une seule écriture, une seule annulation', async () => {
    const { taskId, conflictId } = await timeConflict();
    const results = await Promise.all([bench.useCases.restore(conflictId), bench.useCases.restore(conflictId)]);
    expect(results.map((r) => r.status).sort()).toEqual(['already', 'restored']);
    expect(await outbox('task', taskId)).toEqual([{ field: 'time' }]);
    expect(bench.undo.getSnapshot().size).toBe(1);
    expect(await conflictRow(conflictId)).toMatchObject({ restored: 1 });
  });

  it('Y-04 critère 5 : échec pendant la restauration d’un élément (rappels) : tout est annulé, la tâche reste supprimée', async () => {
    const task = await bench.createTask('Courses');
    await bench.data.repos.reminders.replaceForTarget({ type: 'task', id: task.id }, [
      { id: '70000000-0000-4000-8000-000000000011' as never, targetType: 'task', targetId: task.id, offsetMin: 15, fireAt: '2026-10-05T08:45' as never },
    ]);
    bench.clock.advance(1_000);
    const [removed] = await bench.data.repos.tasks.softDelete([task.id]);
    await bench.data.repos.reminders.softDeleteForTarget({ type: 'task', id: task.id }, removed?.deletedAt ?? undefined);
    await published();
    const conflictId = await bench.conflict({ table: 'task', rowId: task.id, field: 'deleted_at', kept: removed?.deletedAt ?? null, discarded: 'modified' });
    const heal = failWrites(/^\s*UPDATE reminder\b/i);
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'failed' });
    heal();
    expect((await bench.data.repos.tasks.getById(task.id, { includeDeleted: true }))?.deletedAt).not.toBeNull();
    expect(bench.taskEntities.get(task.id)).toBeUndefined();
    expect(await conflictRow(conflictId)).toEqual({ restored: 0, resolved_at: null });
    expect(await outbox('task', task.id)).toEqual([]);
    expect(bench.undo.getSnapshot().size).toBe(0);
    // Après réparation, la même restauration aboutit.
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'restored' });
    expect((await bench.data.repos.tasks.getById(task.id))?.deletedAt).toBeNull();
  });

  it('Y-04 critère 7 : tâche supprimée depuis plus de 30 jours mais non purgée : « Restaurer » la restaure quand même, rappels compris', async () => {
    const task = await bench.createTask('Ancienne');
    await bench.data.repos.reminders.replaceForTarget({ type: 'task', id: task.id }, [
      { id: '70000000-0000-4000-8000-000000000012' as never, targetType: 'task', targetId: task.id, offsetMin: 15, fireAt: '2026-10-05T08:45' as never },
    ]);
    bench.clock.advance(1_000);
    const [removed] = await bench.data.repos.tasks.softDelete([task.id]);
    await bench.data.repos.reminders.softDeleteForTarget({ type: 'task', id: task.id }, removed?.deletedAt ?? undefined);
    bench.clock.advance(40 * 86_400_000);
    await published();
    const conflictId = await bench.conflict({ table: 'task', rowId: task.id, field: 'deleted_at', kept: removed?.deletedAt ?? null, discarded: 'modified' });
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'restored' });
    expect((await bench.data.repos.tasks.getById(task.id))?.deletedAt).toBeNull();
    expect((await bench.data.repos.reminders.listForTarget({ type: 'task', id: task.id })).map((r) => r.deletedAt)).toEqual([null]);
    expect(bench.taskEntities.get(task.id)?.title).toBe('Ancienne');
    expect(await conflictRow(conflictId)).toMatchObject({ restored: 1 });
  });
});

describe('Y-04 critère 6 : annulation (compléments de la QA)', () => {
  it('Y-04 critère 6 : saisie ultérieure dans un autre champ de la même tâche : l’annulation reste possible et garde la saisie', async () => {
    const { taskId, conflictId } = await timeConflict();
    await bench.useCases.restore(conflictId);
    bench.clock.advance(1_000);
    await bench.data.repos.tasks.update(taskId, { note: 'avec le devis' });
    bench.clock.advance(1_000);
    expect((await bench.undo.undoLast()).status).toBe('undone');
    const task = await bench.data.repos.tasks.getById(taskId);
    expect(task?.time).toBe('09:00');
    expect(task?.note).toBe('avec le devis');
    expect(await conflictRow(conflictId)).toEqual({ restored: 0, resolved_at: null });
  });

  it('Y-04 critère 6 : l’annulation ne se rejoue pas (la commande est consommée) et ne réécrit rien', async () => {
    const { taskId, conflictId } = await timeConflict();
    await bench.useCases.restore(conflictId);
    bench.clock.advance(1_000);
    expect((await bench.undo.undoLast()).status).toBe('undone');
    await published();
    expect((await bench.undo.undoLast()).status).toBe('empty');
    expect(await outbox('task', taskId)).toEqual([]);
  });

  it('Y-04 critère 6 : l’annulation échoue (base) : l’erreur remonte à l’appelant (message visible), rien n’est écrit, la restauration reste', async () => {
    const { taskId, conflictId } = await timeConflict();
    await bench.useCases.restore(conflictId);
    await published();
    bench.clock.advance(1_000);
    const heal = failWrites(/^\s*UPDATE conflict_log\b/i);
    await expect(bench.undo.undoLast()).rejects.toThrow();
    heal();
    expect((await bench.data.repos.tasks.getById(taskId))?.time).toBe('10:00');
    expect(await outbox('task', taskId)).toEqual([]);
    expect(await conflictRow(conflictId)).toMatchObject({ restored: 1 });
  });

  it('Y-04 critère 6 : annulation d’une restauration d’élément après modification du titre : refusée (stale)', async () => {
    const task = await bench.createTask('Courses');
    bench.clock.advance(1_000);
    const [removed] = await bench.data.repos.tasks.softDelete([task.id]);
    await published();
    const conflictId = await bench.conflict({ table: 'task', rowId: task.id, field: 'deleted_at', kept: removed?.deletedAt ?? null, discarded: 'modified' });
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'restored' });
    bench.clock.advance(1_000);
    await bench.data.repos.tasks.softDelete([task.id]);
    bench.clock.advance(1_000);
    expect((await bench.undo.undoLast()).status).toBe('stale');
    expect((await bench.data.repos.tasks.getById(task.id, { includeDeleted: true }))?.deletedAt).not.toBeNull();
  });
});

describe('Y-04 critère 9 : valeur validée par le type de la colonne', () => {
  const valid: readonly [string, SyncValue, SyncValue][] = [
    ['note', 'a', 'texte restauré'],
    ['time', '09:00', null],
    ['date', '2026-10-05', '2026-12-31'],
    ['status', 'todo', 'done'],
    ['someday', 0, 1],
    ['icon', null, 'star'],
  ];
  it.each(valid)('colonne %s : valeur écartée valide, restaurée', async (field, kept, discarded) => {
    const task = await bench.createTask('Types');
    await bench.stamped(`UPDATE task SET ${field} = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ?`, [kept, STAMP_AT, STAMP_DEVICE, STAMP_HLC, task.id]);
    await published();
    const id = await bench.conflict({ table: 'task', rowId: task.id, field, kept, discarded });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'restored' });
    const [row] = await bench.select(`SELECT ${field} AS v FROM task WHERE id = ?`, [task.id]);
    expect(row?.['v']).toBe(discarded);
  });

  const invalid: readonly [string, unknown][] = [
    ['title', null],
    ['title', 42],
    ['title', 'x'.repeat(5_000)],
    ['status', 'zzz'],
    ['status', 1],
    ['someday', 2],
    ['someday', true],
    ['date', '2026-13-40'],
    ['date', 20_261_005],
    ['time', '24:61'],
    ['time', '9:00'],
    ['note', { toString: 'x' }],
    ['note', ['a']],
    ['project_id', 'pas-un-identifiant'],
    ['project_id', "' OR 1=1 --"],
    ['source', 'inconnue'],
    ['series_index', 1.5],
  ];
  it.each(invalid)('colonne %s, valeur falsifiée %j : refus « valeur invalide », rien n’est écrit', async (field, value) => {
    const task = await bench.createTask('Falsifié');
    await published();
    const id = await bench.conflict({ table: 'task', rowId: task.id, field, kept: 'k', discarded: value as SyncValue });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'refused', reason: 'invalid' });
    expect(await outbox('task', task.id)).toEqual([]);
    expect(await conflictRow(id)).toEqual({ restored: 0, resolved_at: null });
    // L'écran sait la dire sans planter, et le journal reste lisible.
    expect((await bench.useCases.list(1)).items[0]).toMatchObject({ blocked: 'invalid' });
  });

  it('Y-04 critère 9 : identifiant de ligne hostile : requête paramétrée, refus propre, aucune table touchée', async () => {
    const evil = "x' OR '1'='1'; DROP TABLE task; --";
    const task = await bench.createTask('Intacte');
    await published();
    const id = await bench.conflict({ table: 'task', rowId: evil, field: 'title', kept: 'A', discarded: 'B' });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'refused', reason: 'row-gone' });
    expect((await bench.useCases.list(1)).items[0]).toMatchObject({ blocked: 'row-gone', itemState: 'missing' });
    expect((await bench.data.repos.tasks.getById(task.id))?.title).toBe('Intacte');
  });

  it('Y-04 critère 9 : la valeur écartée d’une suppression doit être une date ISO (sinon « valeur invalide »)', async () => {
    const task = await bench.createTask('Date');
    await published();
    const id = await bench.conflict({ table: 'task', rowId: task.id, field: 'deleted_at', kept: null, discarded: 'pas une date' });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'refused', reason: 'invalid' });
    expect((await bench.data.repos.tasks.getById(task.id))?.deletedAt).toBeNull();
  });
});

describe('Y-04 critère 10 : valeur actuelle égale à la valeur écartée', () => {
  it('Y-04 critère 10 : valeur nulle déjà en place : aucune écriture, conflit résolu', async () => {
    const task = await bench.createTask('Sans heure');
    await published();
    bench.clock.advance(1_000);
    const id = await bench.conflict({ table: 'task', rowId: task.id, field: 'time', kept: '09:00', discarded: null });
    expect(await bench.useCases.restore(id)).toEqual({ status: 'already' });
    expect(await outbox('task', task.id)).toEqual([]);
    expect(await conflictRow(id)).toMatchObject({ restored: 1 });
  });

  it('Y-04 critère 10 : même valeur écartée par deux conflits successifs : le second est « déjà en place » après le premier', async () => {
    const { taskId, conflictId } = await timeConflict();
    const second = await bench.conflict({ table: 'task', rowId: taskId, field: 'time', kept: '09:00', discarded: '10:00', keptHlc: otherHlc(700) });
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'restored' });
    await published();
    expect(await bench.useCases.restore(second)).toEqual({ status: 'already' });
    expect(await outbox('task', taskId)).toEqual([]);
    expect(bench.undo.getSnapshot().size).toBe(1);
    expect(await bench.select('SELECT restored FROM conflict_log ORDER BY id')).toEqual([{ restored: 1 }, { restored: 1 }]);
  });
});

describe('Y-04 critère 14 : journal technique sans contenu (compléments de la QA)', () => {
  it('Y-04 critère 9 : parcours complet (refus, restauration, annulation) : aucun titre, valeur, identifiant ni nom d’appareil dans le journal technique', async () => {
    const { taskId, conflictId } = await timeConflict();
    await bench.useCases.restore(conflictId);
    bench.clock.advance(1_000);
    await bench.undo.undoLast();
    await bench.useCases.restore(424_242);
    const text = JSON.stringify(bench.logger.entries);
    for (const secret of ['10:00', '09:00', 'Envoyer la facture', taskId, SELF, OTHER]) expect(text).not.toContain(secret);
    expect(bench.logger.entries.map((e) => (e.detail as { outcome: string }).outcome)).toEqual(['restored', 'undone', 'row-gone']);
  });
});
