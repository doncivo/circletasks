import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewTask } from '../../domain/model';
import { asEntityId, asLocalDate, type DeviceId, type RecurrenceId, type ReminderId, type TaskId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities } from '../app/taskEntities';
import { DEDUP_FAILURES_META } from '../../domain/occurrenceDedup';
import { RECURRENCE_DEDUP_META, runRecurrenceDedup, runRecurrenceDedupCounted } from './recurrenceDedup';

/**
 * T-TECH-01 critères 15, 16 et 19 : nettoyage des doublons d'occurrences existants (passage JavaScript retenu par le spike, critère 14).
 * Le survivant d'un groupe (D7) est testé seul dans `src/domain/occurrenceDedup.test.ts` ; ici, la base réelle.
 */

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-0000000000d1');
const R = asEntityId<RecurrenceId>('41000000-0000-4000-8000-000000000001');
const id = (n: number): TaskId => asEntityId<TaskId>(`42000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

function task(n: number, seriesIndex: number | null, extra: Partial<NewTask> = {}): NewTask {
  return {
    id: id(n),
    spaceId: SPACE_PRO_ID,
    projectId: null,
    title: `Occurrence ${String(n)}`,
    note: '',
    date: asLocalDate('2026-10-24'),
    time: null,
    status: 'todo',
    doneAt: null,
    sortOrder: n,
    carriedOver: false,
    recurrenceId: R,
    seriesIndex,
    seriesTemplate: null,
    goalId: null,
    icon: null,
    someday: false,
    source: 'local',
    externalId: null,
    appleListId: null,
    appleRecurring: false,
    externalEventId: null,
    ...extra,
  };
}

const done = { status: 'done', doneAt: '2026-10-24T09:00:00.000Z' } as Partial<NewTask>;
const dump = (db: TestDb): Promise<Record<string, unknown>[]> => db.driver.select('SELECT * FROM task ORDER BY id');

describe('nettoyage des doublons d’occurrences (T-TECH-01 critères 15, 16, 19)', () => {
  let db: TestDb;
  const entities = createTaskEntities();
  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-24T08:00:00.000Z');
    await db.data.repos.recurrences.create({ id: R, freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null });
  });
  afterEach(() => db.close());

  /** Les créations se suivent à une milliseconde d'écart : le hlc croît avec le numéro de ligne. */
  async function seed(rows: readonly NewTask[]): Promise<void> {
    for (const row of rows) {
      db.clock.advance(1);
      await db.data.repos.tasks.create(row);
    }
  }

  it('critère 15 : (a) à (h), survivants attendus, autres lignes inchangées (ensemble complet avant et après)', async () => {
    await seed([
      task(1, 5), task(2, 5), // (a) deux à faire : la plus récente survit
      task(3, 6, done), task(4, 6), // (b) la terminée survit malgré un hlc plus ancien
      task(5, 7, done), task(6, 7, done), // (c) deux terminées : la plus récente
      task(7, 8), task(8, 8), task(9, 8), // (d) trois lignes
      task(10, 9), // (e) seule
      task(11, -1), task(12, -1), // (f) marqueur d'annulation
      task(13, null), task(14, null), // (g) sans index
      task(15, 10), task(16, 10), // (h) une supprimée, une vivante
    ]);
    await db.data.repos.tasks.softDelete([id(15)]);
    const before = await dump(db);

    const result = await runRecurrenceDedup({ data: db.data, taskEntities: entities });

    expect(result).toEqual({ groups: 4, removed: 5, restored: 0 });
    const after = await dump(db);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    const discarded = [id(1), id(4), id(5), id(7), id(8)];
    for (const [index, row] of after.entries()) {
      const was = before[index] ?? {};
      if (discarded.includes(row.id as TaskId)) {
        expect(row.deleted_at, String(row.id)).not.toBeNull();
        expect({ ...row, deleted_at: null, updated_at: null, device_id: null, hlc: null }).toEqual({ ...was, deleted_at: null, updated_at: null, device_id: null, hlc: null });
      } else expect(row, String(row.id)).toEqual(was); // survivants et lignes hors groupes : octet pour octet
    }
    const live = after.filter((r) => r.deleted_at === null && r.series_index !== null && Number(r.series_index) >= 0).map((r) => [r.series_index, r.id]);
    expect(live).toEqual([[5, id(2)], [6, id(3)], [7, id(6)], [8, id(9)], [9, id(10)], [10, id(16)]]);
  });

  it('critère 15 : rien à faire : aucune écriture ; réexécutable : un doublon arrivé ensuite est repris au passage suivant', async () => {
    await seed([task(1, 1), task(2, 2)]);
    const before = await dump(db);
    expect(await runRecurrenceDedup({ data: db.data, taskEntities: entities })).toEqual({ groups: 0, removed: 0, restored: 0 });
    expect(await dump(db)).toEqual(before);
    await seed([task(3, 1)]); // un doublon arrive ensuite (appareil resté en version antérieure)
    expect(await runRecurrenceDedup({ data: db.data, taskEntities: entities })).toEqual({ groups: 1, removed: 1, restored: 0 });
    expect((await dump(db)).filter((r) => r.deleted_at !== null).map((r) => r.id)).toEqual([id(1)]);
    expect(await runRecurrenceDedup({ data: db.data, taskEntities: entities })).toEqual({ groups: 0, removed: 0, restored: 0 });
  });

  it('critère 16 : les rappels de l’écartée sont supprimés avec elle, ceux de la survivante intacts', async () => {
    await seed([task(1, 5, { time: '09:00' as never }), task(2, 5, { time: '09:00' as never })]);
    const reminder = (n: number, target: TaskId) => ({ id: asEntityId<ReminderId>(`43000000-0000-4000-8000-${String(n).padStart(12, '0')}`), targetType: 'task' as const, targetId: target, offsetMin: 30 as never, fireAt: '2026-10-24T08:30' as never });
    await db.data.repos.reminders.replaceForTarget({ type: 'task', id: id(1) }, [reminder(1, id(1))]);
    await db.data.repos.reminders.replaceForTarget({ type: 'task', id: id(2) }, [reminder(2, id(2))]);

    await runRecurrenceDedup({ data: db.data, taskEntities: entities });

    expect(await db.data.repos.reminders.listForTarget({ type: 'task', id: id(1) })).toEqual([]);
    expect((await db.data.repos.reminders.listForTarget({ type: 'task', id: id(2) })).map((r) => r.id)).toEqual([reminder(2, id(2)).id]);
    const trashed = await db.driver.select("SELECT deleted_at FROM reminder WHERE target_id = '" + id(1) + "'");
    expect(trashed).toHaveLength(1); // supprimé logiquement, jamais physiquement
  });

  it('critère 16 : toute table qui référence une tâche est dans la liste traitée explicitement', async () => {
    const referencing = await db.driver.select<{ table_name: string; column_name: string }>(
      `SELECT m.name AS table_name, p."from" AS column_name FROM sqlite_master m, pragma_foreign_key_list(m.name) p WHERE m.type = 'table' AND p."table" = 'task'
       UNION SELECT m.name, c.name FROM sqlite_master m, pragma_table_info(m.name) c WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND (c.name = 'task_id' OR (m.name = 'reminder' AND c.name = 'target_id'))`,
    );
    // Aucune clé étrangère vers task(id) ; références par valeur, chacune traitée : voir la liste de docs/stories/T-TECH-01.md.
    //   reminder.target_id (target_type 'task')  : supprimés avec l'écartée (`softDeleteForTarget`)
    //   focus_session.task_id                    : laissée (la session reste comptée, la tâche est dans la Corbeille)
    //   apple_reminder_link.task_id              : laissée (une occurrence créée par la série n'a aucun lien Rappels Apple)
    expect(referencing.map((r) => `${r.table_name}.${r.column_name}`).sort()).toEqual(['apple_reminder_link.task_id', 'focus_session.task_id', 'reminder.target_id']);
  });

  it('critère 19 : l’entrée de journal technique porte des nombres, jamais un titre', async () => {
    await seed([task(1, 5), task(2, 5)]);
    const log = vi.fn();
    await runRecurrenceDedup({ data: db.data, taskEntities: entities, log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('recurrence-dedup {"groups":1,"removed":1,"restored":0}');
    expect(String(log.mock.calls[0]?.[0])).not.toContain('Occurrence');
  });

  it('critère 19 : rien à écarter, rien dans le journal', async () => {
    await seed([task(1, 5)]);
    const log = vi.fn();
    await runRecurrenceDedup({ data: db.data, taskEntities: entities, log });
    expect(log).not.toHaveBeenCalled();
  });

  it('I4 : les échecs sont comptés dans sync_meta (journalisés, relancés), un passage réussi remet le compteur à zéro', async () => {
    const broken = { ...db.data, transaction: () => Promise.reject(new Error('base occupée')) } as typeof db.data;
    for (let n = 1; n <= 3; n += 1) {
      await expect(runRecurrenceDedupCounted({ data: broken, taskEntities: entities, log: () => undefined })).rejects.toThrow('base occupée');
      expect(await db.data.repos.sync.getMeta(DEDUP_FAILURES_META)).toBe(String(n));
    }
    await runRecurrenceDedupCounted({ data: { ...db.data, repos: db.data.repos, transaction: db.data.transaction }, taskEntities: entities, log: () => undefined });
    expect(await db.data.repos.sync.getMeta(DEDUP_FAILURES_META)).toBeNull();
  });

  it.each(['pas du JSON', 'null', '{"groups":null}', '{"groups":[],"deletions":{"x":"horloge invalide"}}'])('R1 : un suivi illisible est conservé et son échec est compté : %s', async (raw) => {
    await db.data.repos.sync.setMeta(RECURRENCE_DEDUP_META, raw);
    const log = vi.fn();
    await expect(runRecurrenceDedupCounted({ data: db.data, taskEntities: entities, log })).rejects.toMatchObject({ code: 'io' });
    expect(await db.data.repos.sync.getMeta(RECURRENCE_DEDUP_META)).toBe(raw);
    expect(await db.data.repos.sync.getMeta(DEDUP_FAILURES_META)).toBe('1');
    expect(log).toHaveBeenCalledWith('recurrence-dedup-state-unreadable {"code":"parse"}');
  });

  it('R1 : un accusé illisible ne clôt aucun suivi ; échec compté et état conservé', async () => {
    await seed([task(1, 1), task(2, 1)]);
    await runRecurrenceDedup({ data: db.data, taskEntities: entities });
    const tracked = await db.data.repos.sync.getMeta(RECURRENCE_DEDUP_META);
    const peer = asEntityId<DeviceId>('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await db.data.repos.sync.saveState(peer, { isSelf: false, lastAcks: 'illisible', status: 'active' });
    const log = vi.fn();
    await expect(runRecurrenceDedupCounted({ data: db.data, taskEntities: entities, log })).rejects.toMatchObject({ code: 'io' });
    expect(await db.data.repos.sync.getMeta(RECURRENCE_DEDUP_META)).toBe(tracked);
    expect(await db.data.repos.sync.getMeta(DEDUP_FAILURES_META)).toBe('1');
    expect(log).toHaveBeenCalledWith('state-unreadable {"where":"recurrence-dedup.acks"}');
  });
});
