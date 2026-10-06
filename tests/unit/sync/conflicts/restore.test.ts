import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../../../src/db/driver';
import type { TaskId } from '../../../../src/domain/types';
import { undoMessage } from '../../../../src/features/app/undo';
import { OTHER, PRO, SELF, STAMP_AT, STAMP_DEVICE, STAMP_HLC, openConflictBench, otherHlc, type ConflictBench } from './kit';

/**
 * Restauration de la valeur écartée (Y-04 critères 5 à 10 ; ADR 0011 §4.2, §4.3, §5.4 ; decisions.md Y-04 D3) : une seule transaction,
 * nouvelle écriture locale tamponnée (base = horloge courante du champ, entrée de file), `restored` et `resolved_at`, annulation 5 s
 * (`syncRestore`, `'stale'` si le champ a changé), conflit « supprimé / modifié », refus (ligne ou parent disparu, valeur invalide),
 * valeur déjà en place, champ modifié depuis, journal falsifié, échec visible.
 */

let bench: ConflictBench;

beforeEach(async () => {
  bench = await openConflictBench();
});

afterEach(async () => {
  await bench.close();
});

const fieldClock = async (table: string, id: string, field: string) =>
  (await bench.select<{ hlc: string; base_hlc: string | null }>('SELECT hlc, base_hlc FROM sync_field_clock WHERE table_name = ? AND row_id = ? AND field = ?', [table, id, field]))[0] ?? null;
const outbox = (table: string, id: string) => bench.select<{ field: string }>('SELECT field FROM sync_outbox WHERE table_name = ? AND row_id = ? ORDER BY field', [table, id]);
const conflictRow = async (id: number) => (await bench.select<{ restored: number; resolved_at: string | null }>('SELECT restored, resolved_at FROM conflict_log WHERE id = ?', [id]))[0];
/** La file est vide : tout a été publié (état d'un appareil après un cycle). */
const published = () => bench.driver.execute('DELETE FROM sync_outbox');

/** Tâche dont l'heure 09:00 vient de l'autre appareil (valeur gardée), et le conflit 09:00 gardée / 10:00 écartée. */
async function timeConflict(current = '09:00'): Promise<{ taskId: TaskId; conflictId: number }> {
  const task = await bench.createTask('Envoyer la facture', { time: '09:00' as never });
  if (current !== '09:00') {
    bench.clock.advance(1_000);
    await bench.data.repos.tasks.update(task.id, { time: current as never });
  }
  await published();
  bench.clock.advance(1_000);
  const conflictId = await bench.conflict({ table: 'task', rowId: task.id, field: 'time', kept: '09:00', discarded: '10:00', keptHlc: otherHlc(500), discardedHlc: otherHlc(400, SELF) });
  return { taskId: task.id, conflictId };
}

describe('restauration d’une valeur (critère 5)', () => {
  it('une seule transaction : nouvelle écriture tamponnée, base = horloge courante du champ, entrée de file, restored et resolved_at', async () => {
    const { taskId, conflictId } = await timeConflict();
    const before = await bench.select<{ hlc: string }>('SELECT hlc FROM task WHERE id = ?', [taskId]);
    const clockBefore = (await fieldClock('task', taskId, 'time'))?.hlc ?? (await fieldClock('task', taskId, '*'))?.hlc ?? before[0]?.hlc;
    let transactions = 0;
    let outside = 0;
    const realTransaction = bench.driver.transaction.bind(bench.driver);
    const realExecute = bench.driver.execute.bind(bench.driver);
    bench.driver.transaction = ((fn: (tx: SqlExecutor) => Promise<unknown>) => {
      transactions += 1;
      return realTransaction(fn);
    }) as typeof bench.driver.transaction;
    bench.driver.execute = ((sql: string, params?: unknown[]) => {
      outside += 1;
      return realExecute(sql, params as never);
    }) as typeof bench.driver.execute;

    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'restored' });
    expect(transactions).toBe(1);
    expect(outside).toBe(0);

    const task = await bench.data.repos.tasks.getById(taskId);
    expect(task?.time).toBe('10:00');
    const clock = await fieldClock('task', taskId, 'time');
    expect(clock?.hlc.endsWith(SELF)).toBe(true);
    expect(String(clock?.hlc) > String(clockBefore)).toBe(true);
    expect(clock?.base_hlc).toBe(clockBefore);
    expect(await outbox('task', taskId)).toEqual([{ field: 'time' }]);
    expect(await conflictRow(conflictId)).toEqual({ restored: 1, resolved_at: new Date(bench.clock.nowMs()).toISOString() });
    // Le champ affiche la valeur restaurée sans recharger : la source unique des tâches est à jour.
    expect(bench.taskEntities.get(taskId)?.time).toBe('10:00');
  });

  it('déjà restaurée : rien n’est réécrit', async () => {
    const { taskId, conflictId } = await timeConflict();
    await bench.useCases.restore(conflictId);
    await published();
    const hlc = (await fieldClock('task', taskId, 'time'))?.hlc;
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'already' });
    expect((await fieldClock('task', taskId, 'time'))?.hlc).toBe(hlc);
    expect(await outbox('task', taskId)).toEqual([]);
  });
});

describe('annulation (critère 6)', () => {
  it('« Valeur restaurée · Annuler » : nouvelle écriture de la valeur gardée, restored = 0 et resolved_at = NULL', async () => {
    const { taskId, conflictId } = await timeConflict();
    await bench.useCases.restore(conflictId);
    const top = bench.undo.getSnapshot().top;
    expect(top?.kind).toBe('syncRestore');
    expect(top && undoMessage(top)).toBe('Valeur restaurée');
    const restoredHlc = (await fieldClock('task', taskId, 'time'))?.hlc;
    await published();
    bench.clock.advance(1_000);
    const result = await bench.undo.undoLast();
    expect(result.status).toBe('undone');
    expect((await bench.data.repos.tasks.getById(taskId))?.time).toBe('09:00');
    const clock = await fieldClock('task', taskId, 'time');
    expect(String(clock?.hlc) > String(restoredHlc)).toBe(true);
    expect(clock?.base_hlc).toBe(restoredHlc);
    expect(await outbox('task', taskId)).toEqual([{ field: 'time' }]);
    expect(await conflictRow(conflictId)).toEqual({ restored: 0, resolved_at: null });
    expect(bench.taskEntities.get(taskId)?.time).toBe('09:00');
  });

  it('champ modifié depuis la restauration : refusée (stale), rien n’est écrasé', async () => {
    const { taskId, conflictId } = await timeConflict();
    await bench.useCases.restore(conflictId);
    bench.clock.advance(1_000);
    await bench.data.repos.tasks.update(taskId, { time: '12:00' as never });
    const result = await bench.undo.undoLast();
    expect(result.status).toBe('stale');
    expect((await bench.data.repos.tasks.getById(taskId))?.time).toBe('12:00');
    expect(await conflictRow(conflictId)).toMatchObject({ restored: 1 });
  });
});

describe('suppression contre modification (critère 7)', () => {
  it('tâche supprimée ailleurs, modifiée ici : « Restaurer » restaure la tâche et ses rappels (corbeille T-08), annulable', async () => {
    const task = await bench.createTask('Courses', { time: '09:00' as never });
    await bench.data.repos.reminders.replaceForTarget({ type: 'task', id: task.id }, [
      { id: '70000000-0000-4000-8000-000000000001' as never, targetType: 'task', targetId: task.id, offsetMin: 15, fireAt: '2026-10-05T08:45' as never },
    ]);
    bench.clock.advance(1_000);
    const [removed] = await bench.data.repos.tasks.softDelete([task.id]);
    await bench.data.repos.reminders.softDeleteForTarget({ type: 'task', id: task.id }, removed?.deletedAt ?? undefined);
    await published();
    bench.clock.advance(1_000);
    const conflictId = await bench.conflict({ table: 'task', rowId: task.id, field: 'deleted_at', kept: removed?.deletedAt ?? null, discarded: 'modified', keptHlc: otherHlc(900), discardedHlc: otherHlc(800, SELF) });

    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'restored' });
    expect((await bench.data.repos.tasks.getById(task.id))?.deletedAt).toBeNull();
    expect((await bench.data.repos.reminders.listForTarget({ type: 'task', id: task.id })).map((r) => r.deletedAt)).toEqual([null]);
    // Restauration : la ligne repart entière (« + », Y-09) avec ses rappels.
    expect((await outbox('task', task.id)).map((e) => e.field)).toContain('+');
    expect(bench.taskEntities.get(task.id)?.title).toBe('Courses');
    expect(await conflictRow(conflictId)).toMatchObject({ restored: 1 });

    await published();
    bench.clock.advance(1_000);
    expect((await bench.undo.undoLast()).status).toBe('undone');
    expect((await bench.data.repos.tasks.getById(task.id, { includeDeleted: true }))?.deletedAt).not.toBeNull();
    expect((await bench.data.repos.reminders.listForTarget({ type: 'task', id: task.id })).length).toBe(0);
    expect(bench.taskEntities.get(task.id)).toBeUndefined();
    expect(await conflictRow(conflictId)).toEqual({ restored: 0, resolved_at: null });
  });

  it('routine (voie générique) : deleted_at remis à nul par une écriture tamponnée, rappels de la routine restaurés', async () => {
    const id = '30000000-0000-4000-8000-000000000001';
    await bench.stamped(
      "INSERT INTO routine (id, space_id, title, schedule_type, start_date, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Méditer', 'daily', '2026-10-01', ?, ?, ?, ?)",
      [id, PRO, STAMP_AT, STAMP_AT, STAMP_DEVICE, STAMP_HLC],
    );
    await bench.data.repos.reminders.replaceForTarget({ type: 'routine', id: id as never }, [
      { id: '70000000-0000-4000-8000-000000000002' as never, targetType: 'routine', targetId: id as never, offsetMin: 0, fireAt: '2026-10-05T07:00' as never },
    ]);
    bench.clock.advance(1_000);
    const deletedAt = new Date(bench.clock.nowMs()).toISOString();
    await bench.stamped('UPDATE routine SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ?', [deletedAt, STAMP_AT, STAMP_DEVICE, STAMP_HLC, id]);
    bench.clock.advance(5);
    await bench.data.repos.reminders.softDeleteForTarget({ type: 'routine', id: id as never }, deletedAt as never);
    await published();
    const conflictId = await bench.conflict({ table: 'routine', rowId: id, field: 'deleted_at', kept: deletedAt, discarded: 'modified' });
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'restored' });
    expect(await bench.select('SELECT deleted_at FROM routine WHERE id = ?', [id])).toEqual([{ deleted_at: null }]);
    expect(await bench.select("SELECT deleted_at FROM reminder WHERE target_type = 'routine'")).toEqual([{ deleted_at: null }]);
    expect((await outbox('routine', id)).map((e) => e.field)).toEqual(expect.arrayContaining(['+', 'deleted_at']));
  });

  it('valeur écartée = une suppression (restauration ici, suppression ailleurs) : l’élément est supprimé de nouveau, annulable', async () => {
    const task = await bench.createTask('Restaurée ici');
    await published();
    const conflictId = await bench.conflict({ table: 'task', rowId: task.id, field: 'deleted_at', kept: null, discarded: '2026-10-05T07:00:00.000Z' });
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'restored' });
    expect((await bench.data.repos.tasks.getById(task.id, { includeDeleted: true }))?.deletedAt).not.toBeNull();
    expect(bench.taskEntities.get(task.id)).toBeUndefined();
    expect((await bench.undo.undoLast()).status).toBe('undone');
    expect((await bench.data.repos.tasks.getById(task.id))?.deletedAt).toBeNull();
    // Deux suppressions concurrentes : l'élément est déjà supprimé, rien à écrire.
    await bench.data.repos.tasks.softDelete([task.id]);
    await published();
    const both = await bench.conflict({ table: 'task', rowId: task.id, field: 'deleted_at', kept: '2026-10-05T09:00:00.000Z', discarded: '2026-10-05T07:00:00.000Z', keptHlc: otherHlc(7) });
    expect(await bench.useCases.restore(both)).toEqual({ status: 'already' });
    expect(await outbox('task', task.id)).toEqual([]);
  });

  it('élément déjà restauré (par l’autre appareil) : aucune écriture, conflit résolu', async () => {
    const task = await bench.createTask('Déjà là');
    await published();
    const conflictId = await bench.conflict({ table: 'task', rowId: task.id, field: 'deleted_at', kept: '2026-10-05T08:00:00.000Z', discarded: 'modified' });
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'already' });
    expect(await outbox('task', task.id)).toEqual([]);
    expect(await conflictRow(conflictId)).toMatchObject({ restored: 1 });
  });
});

describe('refus (critère 8)', () => {
  it('ligne purgée (trace) : refus « n’existe plus », aucune écriture', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    await bench.driver.execute("INSERT INTO sync_tombstone (table_name, row_id, deleted_hlc, purged_at) VALUES ('task', ?, ?, ?)", [id, otherHlc(10), '2026-10-05T08:00:00.000Z']);
    const conflictId = await bench.conflict({ table: 'task', rowId: id, field: 'title', kept: 'A', discarded: 'B' });
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'refused', reason: 'row-gone' });
    expect(await bench.select('SELECT COUNT(*) AS n FROM sync_outbox')).toEqual([{ n: 0 }]);
    expect(await conflictRow(conflictId)).toEqual({ restored: 0, resolved_at: null });
    expect(bench.undo.getSnapshot().size).toBe(0);
  });

  it('ligne disparue sans trace : même refus', async () => {
    const conflictId = await bench.conflict({ table: 'task', rowId: '22222222-2222-4222-8222-222222222222', field: 'title', kept: 'A', discarded: 'B' });
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'refused', reason: 'row-gone' });
  });

  it('valeur qui désigne un parent disparu ou purgé : refus « L’élément lié n’existe plus »', async () => {
    const task = await bench.createTask('Avec projet');
    await published();
    const gone = '44444444-4444-4444-8444-444444444444';
    await bench.driver.execute("INSERT INTO sync_tombstone (table_name, row_id, deleted_hlc, purged_at) VALUES ('project', ?, ?, ?)", [gone, otherHlc(10), '2026-10-05T08:00:00.000Z']);
    const purgedParent = await bench.conflict({ table: 'task', rowId: task.id, field: 'project_id', kept: null, discarded: gone });
    const missingParent = await bench.conflict({ table: 'task', rowId: task.id, field: 'project_id', kept: null, discarded: '55555555-5555-4555-8555-555555555555', keptHlc: otherHlc(2) });
    expect(await bench.useCases.restore(purgedParent)).toEqual({ status: 'refused', reason: 'parent-gone' });
    expect(await bench.useCases.restore(missingParent)).toEqual({ status: 'refused', reason: 'parent-gone' });
    expect(await outbox('task', task.id)).toEqual([]);
  });
});

describe('sûreté contre un journal falsifié (critère 9)', () => {
  it('valeur invalide pour la colonne : refus « valeur invalide », rien n’est écrit', async () => {
    const task = await bench.createTask('Heure');
    await published();
    const conflictId = await bench.conflict({ table: 'task', rowId: task.id, field: 'time', kept: '09:00', discarded: '25:99' });
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'refused', reason: 'invalid' });
    expect(await outbox('task', task.id)).toEqual([]);
  });

  it('table, colonne inconnue ou champ masqué : refus, et aucun nom reçu n’atteint le SQL', async () => {
    const task = await bench.createTask('Cible');
    await published();
    const evilTable = 'task; DROP TABLE task; --';
    const evilField = 'title = 1; --';
    const ids = [
      await bench.conflict({ table: evilTable, rowId: task.id, field: 'title', kept: 'A', discarded: 'B' }),
      await bench.conflict({ table: 'task', rowId: task.id, field: evilField, kept: 'A', discarded: 'B' }),
      await bench.conflict({ table: 'task', rowId: task.id, field: 'sort_order', kept: 1, discarded: 2 }),
      await bench.conflict({ table: 'task', rowId: task.id, field: 'discarded', kept: 0, discarded: 1 }),
    ];
    const seen: string[] = [];
    const spy = (exec: SqlExecutor): SqlExecutor => ({
      execute: (sql, params) => {
        seen.push(sql);
        return exec.execute(sql, params);
      },
      select: (sql, params) => {
        seen.push(sql);
        return exec.select(sql, params);
      },
    });
    const realTransaction = bench.driver.transaction.bind(bench.driver);
    bench.driver.transaction = ((fn: (tx: SqlExecutor) => Promise<unknown>) => realTransaction((tx) => fn(spy(tx)))) as typeof bench.driver.transaction;
    for (const id of ids) expect(await bench.useCases.restore(id)).toEqual({ status: 'refused', reason: 'invalid' });
    expect(seen.some((sql) => sql.includes('DROP') || sql.includes(evilField) || sql.includes('sort_order') || /\bdiscarded\b/.test(sql))).toBe(false);
    expect((await bench.data.repos.tasks.getById(task.id))?.title).toBe('Cible');
    // La liste ne les montre pas (critère 2).
    expect((await bench.useCases.list(1)).items).toEqual([]);
  });

  it('le journal technique ne contient ni valeur ni nom reçu : table, champ du catalogue et issue', async () => {
    const { conflictId } = await timeConflict();
    await bench.useCases.restore(conflictId);
    await bench.conflict({ table: 'secret-table', rowId: 'x', field: 'secret-field', kept: 'SECRET-GARDE', discarded: 'SECRET-ECARTE' });
    await bench.useCases.restore(conflictId + 1);
    const text = JSON.stringify(bench.logger.entries);
    expect(bench.logger.entries).toEqual([
      { event: 'conflict-restore', detail: { table: 'task', field: 'time', outcome: 'restored' } },
      { event: 'conflict-restore', detail: { table: 'unknown', field: 'unknown', outcome: 'invalid' } },
    ]);
    for (const secret of ['10:00', '09:00', 'secret', 'SECRET', 'Envoyer']) expect(text).not.toContain(secret);
  });
});

describe('valeur déjà en place, champ modifié depuis (critère 10)', () => {
  it('l’autre appareil a restauré avant moi : aucune écriture, conflit résolu et restauré', async () => {
    const { taskId, conflictId } = await timeConflict('10:00');
    const hlc = (await fieldClock('task', taskId, 'time'))?.hlc;
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'already' });
    expect((await fieldClock('task', taskId, 'time'))?.hlc).toBe(hlc);
    expect(await outbox('task', taskId)).toEqual([]);
    expect(await conflictRow(conflictId)).toEqual({ restored: 1, resolved_at: new Date(bench.clock.nowMs()).toISOString() });
    expect(bench.undo.getSnapshot().size).toBe(0);
  });

  it('champ modifié depuis le conflit : « Restaurer » écrase en un clic, et l’annulation remet la valeur écrasée', async () => {
    const { taskId, conflictId } = await timeConflict('11:30');
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'restored' });
    expect((await bench.data.repos.tasks.getById(taskId))?.time).toBe('10:00');
    expect((await bench.undo.undoLast()).status).toBe('undone');
    expect((await bench.data.repos.tasks.getById(taskId))?.time).toBe('11:30');
  });
});

describe('échec inattendu (exigence d’Ali : jamais silencieux)', () => {
  it('erreur de la base : « failed », rien n’est écrit, issue journalisée sans contenu', async () => {
    const { taskId, conflictId } = await timeConflict();
    const realTransaction = bench.driver.transaction.bind(bench.driver);
    bench.driver.transaction = ((fn: (tx: SqlExecutor) => Promise<unknown>) =>
      realTransaction((tx) =>
        fn({
          select: (sql, params) => tx.select(sql, params),
          execute: (sql, params) => (sql.startsWith('UPDATE conflict_log') ? Promise.reject(new Error('disque plein')) : tx.execute(sql, params)),
        }),
      )) as typeof bench.driver.transaction;
    expect(await bench.useCases.restore(conflictId)).toEqual({ status: 'failed' });
    bench.driver.transaction = realTransaction as typeof bench.driver.transaction;
    expect((await bench.data.repos.tasks.getById(taskId))?.time).toBe('09:00');
    expect(await outbox('task', taskId)).toEqual([]);
    expect(await conflictRow(conflictId)).toEqual({ restored: 0, resolved_at: null });
    expect(bench.undo.getSnapshot().size).toBe(0);
    expect(bench.logger.entries.map((e) => e.event)).toEqual(['conflict-restore', 'conflict-restore-error']);
    expect(JSON.stringify(bench.logger.entries)).not.toContain('disque');
  });
});

describe('appareil d’origine', () => {
  it('valeur gardée venue de l’autre appareil, valeur écartée de celui-ci', async () => {
    const { conflictId } = await timeConflict();
    const [view] = (await bench.useCases.list(1)).items;
    expect(view?.id).toBe(conflictId);
    expect(view?.kept.device).toBe(OTHER);
    expect(view?.discarded.device).toBe(SELF);
  });
});
