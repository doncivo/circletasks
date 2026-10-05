import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFLICT_TITLE_SOURCES } from '../../../../src/db/repositories/sql/syncConflicts';
import { SYNC_TABLES, syncColumn, syncTable } from '../../../../src/domain/sync/syncTables';
import { CONFLICTS_PAGE_SIZE } from '../../../../src/features/sync/syncConflictUseCases';
import { PRO, STAMP_AT, STAMP_DEVICE, STAMP_HLC, openConflictBench, otherHlc, type ConflictBench } from './kit';

/**
 * Lecture du journal (Y-04 critères 1, 2 et 4 ; ADR 0011 §4.3 ; D1, D2) : récents d'abord, 50 par page, 12 derniers mois, champs
 * `conflictVisible` seulement, titre lu au moment de l'affichage (élément supprimé ou purgé signalé), titre d'un identifiant (projet),
 * conflit restauré daté, refus certain calculé à la lecture (affiché en permanence).
 */

let bench: ConflictBench;

beforeEach(async () => {
  bench = await openConflictBench();
});

afterEach(async () => {
  await bench.close();
});

describe('sources des titres', () => {
  it('chaque colonne de titre ou de parent est une colonne du catalogue', () => {
    for (const t of SYNC_TABLES) {
      const source = CONFLICT_TITLE_SOURCES[t.name];
      if (source.kind === 'own' || source.kind === 'parent') expect(syncColumn(t.name, source.column), `${t.name}.${source.column}`).toBeDefined();
      if (source.kind === 'parent') expect(syncTable(source.table), source.table).toBeDefined();
    }
  });
});

describe('journal (critères 1, 2 et 4)', () => {
  it('récents d’abord ; titre lu à l’affichage ; élément supprimé ou purgé ; champs masqués absents', async () => {
    const live = await bench.createTask('Envoyer la facture');
    const deleted = await bench.createTask('Ancienne');
    await bench.data.repos.tasks.softDelete([deleted.id]);
    const purged = '11111111-1111-4111-8111-111111111111';
    await bench.driver.execute("INSERT INTO sync_tombstone (table_name, row_id, deleted_hlc, purged_at) VALUES ('task', ?, ?, ?)", [purged, otherHlc(1), '2026-10-05T08:00:00.000Z']);
    const first = await bench.conflict({ table: 'task', rowId: live.id, field: 'time', kept: '09:00', discarded: '10:00' });
    await bench.conflict({ table: 'task', rowId: live.id, field: 'sort_order', kept: 1, discarded: 2 });
    const second = await bench.conflict({ table: 'task', rowId: deleted.id, field: 'title', kept: 'A', discarded: 'B' });
    const third = await bench.conflict({ table: 'task', rowId: purged, field: 'note', kept: 'x', discarded: 'y' });
    await bench.data.repos.tasks.update(live.id, { title: 'Envoyer la facture de septembre' });

    const page = await bench.useCases.list(1);
    expect(page.hasMore).toBe(false);
    expect(page.items.map((v) => v.id)).toEqual([third, second, first]);
    const [p, d, l] = page.items;
    expect(l).toMatchObject({ title: 'Envoyer la facture de septembre', itemState: 'live', blocked: null, restored: false, restoredAt: null });
    expect(l?.column.name).toBe('time');
    expect(d).toMatchObject({ itemState: 'deleted', blocked: null });
    expect(p).toMatchObject({ itemState: 'purged', title: null, blocked: 'row-gone' });
  });

  it('50 par page, « Afficher plus » ; seuls les 12 derniers mois', async () => {
    const task = await bench.createTask('Beaucoup');
    for (let i = 0; i < CONFLICTS_PAGE_SIZE + 3; i += 1) {
      await bench.conflict({ table: 'task', rowId: task.id, field: 'title', kept: `k${String(i)}`, discarded: `d${String(i)}`, keptHlc: otherHlc(i + 10) });
    }
    await bench.conflict({ table: 'task', rowId: task.id, field: 'title', kept: 'vieux', discarded: 'très vieux', detectedAt: '2025-09-01T00:00:00.000Z', keptHlc: otherHlc(5) });
    const one = await bench.useCases.list(1);
    expect(one.items).toHaveLength(CONFLICTS_PAGE_SIZE);
    expect(one.hasMore).toBe(true);
    const two = await bench.useCases.list(2);
    expect(two.items).toHaveLength(CONFLICTS_PAGE_SIZE + 3);
    expect(two.hasMore).toBe(false);
    expect(two.items.some((v) => v.kept.value === 'vieux')).toBe(false);
  });

  it('conflit restauré : date de restauration (D2), plus de refus calculé', async () => {
    const task = await bench.createTask('Heure', { time: '09:00' as never });
    const id = await bench.conflict({ table: 'task', rowId: task.id, field: 'time', kept: '09:00', discarded: '10:00' });
    bench.clock.advance(60_000);
    await bench.useCases.restore(id);
    const [view] = (await bench.useCases.list(1)).items;
    expect(view).toMatchObject({ restored: true, restoredAt: new Date(bench.clock.nowMs()).toISOString(), blocked: null });
  });

  it('titres : jour de routine par sa routine, rappel par sa cible ; identifiant de projet par le nom du projet ; parent disparu signalé', async () => {
    const routine = '30000000-0000-4000-8000-000000000001';
    await bench.stamped(
      "INSERT INTO routine (id, space_id, title, schedule_type, start_date, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Méditer', 'daily', '2026-10-01', ?, ?, ?, ?)",
      [routine, PRO, STAMP_AT, STAMP_AT, STAMP_DEVICE, STAMP_HLC],
    );
    const log = `rlog|${routine}|2026-10-05`;
    await bench.stamped("INSERT INTO routine_log (id, routine_id, date, done_at, created_at, updated_at, device_id, hlc) VALUES (?, ?, '2026-10-05', ?, ?, ?, ?, ?)", [
      log,
      routine,
      STAMP_AT,
      STAMP_AT,
      STAMP_AT,
      STAMP_DEVICE,
      STAMP_HLC,
    ]);
    const project = '40000000-0000-4000-8000-000000000001';
    await bench.stamped("INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Clients', '#2f6b7a', 1, ?, ?, ?, ?)", [
      project,
      PRO,
      STAMP_AT,
      STAMP_AT,
      STAMP_DEVICE,
      STAMP_HLC,
    ]);
    const task = await bench.createTask('Relancer', { projectId: project as never });
    await bench.data.repos.reminders.replaceForTarget({ type: 'task', id: task.id }, [
      { id: '70000000-0000-4000-8000-000000000001' as never, targetType: 'task', targetId: task.id, offsetMin: 15, fireAt: '2026-10-05T08:45' as never },
    ]);
    await bench.conflict({ table: 'routine_log', rowId: log, field: 'deleted_at', kept: null, discarded: '2026-10-05T09:00:00.000Z', keptHlc: otherHlc(3) });
    await bench.conflict({ table: 'reminder', rowId: '70000000-0000-4000-8000-000000000001', field: 'offset_min', kept: 15, discarded: 60, keptHlc: otherHlc(4) });
    await bench.conflict({ table: 'task', rowId: task.id, field: 'project_id', kept: project, discarded: '99999999-9999-4999-8999-999999999999', keptHlc: otherHlc(5) });
    const [byProject, byReminder, byLog] = (await bench.useCases.list(1)).items;
    expect(byLog?.title).toBe('Méditer');
    expect(byReminder?.title).toBe('Relancer');
    expect(byProject?.title).toBe('Relancer');
    expect(byProject?.kept.ref).toBe('Clients');
    expect(byProject?.discarded.ref).toBeNull();
    expect(byProject?.blocked).toBe('parent-gone');
  });
});

describe('page complète après le filtre, lignes illisibles isolées (suggestions de la revue, défauts 2 et 3 de la QA)', () => {
  it('60 conflits récents de champ masqué devant un conflit visible : la première page montre le conflit visible', async () => {
    const task = await bench.createTask('Ancien conflit visible');
    await bench.conflict({ table: 'task', rowId: task.id, field: 'title', kept: 'A', discarded: 'B', keptHlc: otherHlc(1) });
    for (let i = 0; i < 60; i += 1) await bench.conflict({ table: 'task', rowId: task.id, field: 'sort_order', kept: i, discarded: i + 1, keptHlc: otherHlc(i + 10) });
    const page = await bench.useCases.list(1);
    expect(page.items.map((v) => v.column.name)).toEqual(['title']);
    expect(page.hasMore).toBe(false);
  });

  it('une ligne au contenu altéré : les autres sont listées, elle est comptée ; « Restaurer » la refuse (valeur invalide)', async () => {
    const task = await bench.createTask('Lisible');
    await bench.conflict({ table: 'task', rowId: task.id, field: 'title', kept: 'A', discarded: 'B' });
    await bench.driver.execute("INSERT INTO conflict_log (table_name, row_id, field, kept_value, discarded_value, detected_at) VALUES ('task', ?, 'note', '{altéré', '\"x\"', ?)", [task.id, '2026-10-05T07:00:00.000Z']);
    const altered = Number((await bench.select<{ id: number }>('SELECT MAX(id) AS id FROM conflict_log'))[0]?.id);
    const page = await bench.useCases.list(1);
    expect(page.items).toHaveLength(1);
    expect(page.unreadable).toBe(1);
    expect(await bench.useCases.restore(altered)).toEqual({ status: 'refused', reason: 'invalid' });
  });
});
