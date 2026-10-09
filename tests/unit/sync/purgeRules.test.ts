import { afterEach, describe, expect, it } from 'vitest';
import { openTestDb, type TestDb } from '../../../src/db/repositories/sql/testSetup';
import { createManualClock } from '../../../src/domain/clock';
import type { NewTask } from '../../../src/domain/model';
import { PAGE_ROWS, type DeviceAck, type EpochId } from '../../../src/domain/sync/format';
import { UNBOUNDED } from '../../../src/domain/sync/retention';
import type { DeviceId, Hlc, IsoDateTime, LocalDate, LocalDateTime, ReminderId, SpaceId, TaskId } from '../../../src/domain/types';
import { createAppContainer } from '../../../src/features/app/container';
import { createTrashUseCases } from '../../../src/features/tasks/trashUseCases';
import { createMemorySyncLogger } from '../../../src/sync/log';
import { purgeDeleted } from '../../../src/sync/maintenance';
import { guarded } from '../../../src/sync/guarded';
import { applyOps } from '../../../src/sync/apply';
import { purgeRows } from '../../../src/sync/purge';
import { syncTable, type SyncTable } from '../../../src/domain/sync/syncTables';
import { STATE_FILE } from '../../../src/domain/sync/format';
import { hydrate, propagate } from '../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../sim/syncDevice';

/**
 * Purge des lignes supprimées (ADR 0011 section 5.4 ; Y-09 critères 2, 6 et 11 ; revue Y2 points 7, 8 et 9) : suppression revérifiée
 * dans la transaction gardée, parcours complet malgré des pages retenues, horizon de purge relevé par tout appelant, rappels des
 * tâches purgées purgés et tracés avec elles.
 */

const SELF = '60000000-0000-4000-8000-0000000000c1' as DeviceId;
const READER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const PRO = '00000000-0000-4000-8000-000000000001' as SpaceId;
const DAY = 86_400_000;

let db: TestDb | null = null;
let devices: SimDevice[] = [];
afterEach(async () => {
  await db?.close();
  db = null;
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

const newTask = (n: number): NewTask => ({
  id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as TaskId,
  spaceId: PRO,
  projectId: null,
  title: `Tâche ${String(n)}`,
  note: '',
  date: '2026-10-05' as LocalDate,
  time: null,
  status: 'todo',
  doneAt: null,
  sortOrder: n,
  carriedOver: false,
  recurrenceId: null,
  seriesIndex: null,
  seriesTemplate: null,
  goalId: null,
  icon: null,
  someday: false,
  source: 'local',
  externalId: null,
  appleListId: null,
  appleRecurring: false,
  externalEventId: null,
});

describe('purge : revérification et parcours (revue Y2, point 7)', () => {
  it('une tâche restaurée entre la recherche des candidats et la transaction de purge n’est pas purgée', async () => {
    db = await openTestDb(SELF, '2026-10-05T08:00:00.000Z');
    const data = db.data;
    const [task] = await data.repos.tasks.createMany([newTask(1)]);
    await data.repos.tasks.softDelete([(task as { id: TaskId }).id]);
    db.clock.advance(31 * DAY);
    const sync = data.repos.sync as { deletedRows: typeof data.repos.sync.deletedRows };
    const original = sync.deletedRows.bind(data.repos.sync);
    let restored = false;
    sync.deletedRows = async (...args) => {
      const rows = await original(...args);
      if (!restored && rows.length > 0) {
        restored = true;
        await data.repos.tasks.restore([(task as { id: TaskId }).id]);
      }
      return rows;
    };
    const result = await purgeDeleted({ data, logger: createMemorySyncLogger() }, UNBOUNDED, db.clock.nowMs());
    expect(restored).toBe(true);
    expect(result.count).toBe(0);
    const back = await data.repos.tasks.getById((task as { id: TaskId }).id, { includeDeleted: true });
    expect(back?.deletedAt).toBeNull();
    expect(await db.driver.select('SELECT * FROM sync_tombstone')).toEqual([]);
  });

  it('une première page entièrement retenue n’arrête pas la purge des pages suivantes', async () => {
    db = await openTestDb(SELF, '2026-10-05T08:00:00.000Z');
    const data = db.data;
    const tasks = await data.repos.tasks.createMany(Array.from({ length: PAGE_ROWS + 1 }, (_, i) => newTask(i + 1)));
    const last = tasks.at(-1) as { id: TaskId };
    // La tâche au plus grand identifiant est supprimée d'abord (lue par l'autre appareil) ; les 500 premières ensuite (pas encore lues).
    await data.repos.tasks.softDelete([last.id]);
    const readUpTo = (await data.repos.tasks.getById(last.id, { includeDeleted: true }))?.hlc as Hlc;
    db.clock.advance(1_000);
    // Une seule vraie suppression, puis les 499 autres par une requête (hlc et date de la première) : 500 UPDATE avec les déclencheurs de
    // recherche et de synchro coûtent ~5 ms chacun et dépassaient 5 s sur une machine chargée.
    const [first] = await data.repos.tasks.softDelete([(tasks[0] as { id: TaskId }).id]);
    const firstDeleted = first as { deletedAt: string | null; hlc: string };
    await db.driver.execute('UPDATE task SET deleted_at = ?, updated_at = ?, hlc = ? WHERE id <> ? AND id <> ? AND deleted_at IS NULL', [firstDeleted.deletedAt, firstDeleted.deletedAt, firstDeleted.hlc, (tasks[0] as { id: TaskId }).id, last.id]);
    db.clock.advance(31 * DAY);
    const ack: DeviceAck = { epoch: 'e0001-x' as EpochId, segment: 1, record: 1, hlc: readUpTo, stateSeq: 1 };
    const horizon = { kind: 'limited' as const, readers: [{ deviceId: READER, status: 'active', lastSeenHlc: null, acks: new Map([[SELF, ack]]) }] };
    const result = await purgeDeleted({ data, logger: createMemorySyncLogger() }, horizon, db.clock.nowMs());
    expect(result.count).toBe(1);
    expect(await data.repos.tasks.getById(last.id, { includeDeleted: true })).toBeNull();
    expect(await db.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM task WHERE deleted_at IS NOT NULL')).toEqual([{ n: PAGE_ROWS }]);
  });
});

describe('purge : rappels des tâches purgées (revue Y2, point 9 ; T-08)', () => {
  it('les rappels d’une tâche purgée sont purgés et tracés avec elle, vivants ou supprimés', async () => {
    db = await openTestDb(SELF, '2026-10-05T08:00:00.000Z');
    const data = db.data;
    const [task] = await data.repos.tasks.createMany([newTask(1)]);
    const taskId = (task as { id: TaskId }).id;
    await data.repos.reminders.createMany([
      { id: '90000000-0000-4000-8000-000000000001' as ReminderId, targetType: 'task', targetId: taskId, offsetMin: 15, fireAt: '2026-10-05T09:00' as LocalDateTime },
      { id: '90000000-0000-4000-8000-000000000002' as ReminderId, targetType: 'task', targetId: taskId, offsetMin: 60, fireAt: '2026-10-05T08:00' as LocalDateTime },
    ]);
    // Un rappel supprimé avec la tâche, l'autre resté vivant (écrit après la suppression par un autre appareil, par exemple).
    await data.repos.reminders.softDeleteForTargets('task', [taskId]);
    await data.repos.tasks.softDelete([taskId]);
    await db.driver.execute("UPDATE reminder SET deleted_at = NULL WHERE id = '90000000-0000-4000-8000-000000000002'");
    db.clock.advance(31 * DAY);
    await purgeDeleted({ data, logger: createMemorySyncLogger() }, UNBOUNDED, db.clock.nowMs());
    expect(await data.repos.tasks.getById(taskId, { includeDeleted: true })).toBeNull();
    expect(await db.driver.select('SELECT id FROM reminder')).toEqual([]);
    const tombs = await db.driver.select<{ table_name: string; row_id: string }>('SELECT table_name, row_id FROM sync_tombstone ORDER BY table_name, row_id');
    expect(tombs).toEqual([
      { table_name: 'reminder', row_id: '90000000-0000-4000-8000-000000000001' },
      { table_name: 'reminder', row_id: '90000000-0000-4000-8000-000000000002' },
      { table_name: 'task', row_id: taskId },
    ]);
    expect(await db.driver.select("SELECT * FROM sync_field_clock WHERE table_name = 'reminder'")).toEqual([]);
    expect(await db.driver.select("SELECT * FROM sync_outbox WHERE table_name = 'reminder'")).toEqual([]);
  });
});

describe('purge par la corbeille : horizon de purge (revue Y2, point 8)', () => {
  it('purgeExpired avec synchro relève sync_meta.purgeHorizon (règle 4 de la restauration)', async () => {
    const a = await createSimDevice('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { name: 'PC' });
    const b = await createSimDevice(READER, { name: 'iPhone', clock: createManualClock(a.clock.nowMs()) });
    devices = [a, b];
    await setupFirst(a);
    await a.cycle();
    await pair(a, b);
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    const t = await a.createTask('Corbeille');
    a.clock.advance(1_000);
    await a.deleteTask(t.id);
    for (let i = 0; i < 2; i += 1) {
      for (const d of devices) await d.cycle();
      syncFolders(devices);
    }
    await a.cycle();
    expect(await a.data.repos.sync.getMeta('purgeHorizon')).toBeNull();
    a.clock.advance(31 * DAY);
    const container = createAppContainer({ clock: a.clock, hlc: a.hlc, data: a.data, sync: a.service });
    expect(await createTrashUseCases(container).purgeExpired()).toBe(1);
    const deleted = (await a.driver.select<{ deleted_hlc: string }>('SELECT deleted_hlc FROM sync_tombstone WHERE row_id = ?', [t.id]))[0]?.deleted_hlc;
    expect(JSON.parse(String(await a.data.repos.sync.getMeta('purgeHorizon')))).toBe(deleted);
  });
});

describe('purge au démarrage : rien tant qu’un appareil a des écritures publiées non lues (revue Y2 passe 2, point 1)', () => {
  it('state.ctx de B arrivé, son segment encore dans le nuage : aucune purge par la corbeille ; puis la restauration de B est appliquée', async () => {
    const a = await createSimDevice('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { name: 'PC' });
    const b = await createSimDevice(READER, { name: 'iPhone', clock: a.clock });
    devices = [a, b];
    await setupFirst(a);
    await a.cycle();
    await pair(a, b);
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    const t = await a.createTask('Supprimée puis restaurée par B');
    a.clock.advance(1_000);
    await a.deleteTask(t.id);
    for (let i = 0; i < 2; i += 1) {
      for (const d of devices) await d.cycle();
      syncFolders(devices);
    }
    a.clock.advance(31 * DAY);
    // B restaure la tâche et publie ; chez A, l'état de B arrive, son segment reste dans le nuage.
    await b.data.repos.tasks.restore([t.id]);
    await b.cycle();
    propagate(b.folder, a.folder, READER, { placeholder: true });
    a.folder.setAvailability(READER, STATE_FILE, 'local');
    expect((await a.cycle()).phase).toBe('waiting-icloud');
    const container = createAppContainer({ clock: a.clock, hlc: a.hlc, data: a.data, sync: a.service });
    expect(await createTrashUseCases(container).purgeExpired()).toBe(0);
    expect(await a.task(t.id)).not.toBeNull();
    hydrate(a.folder, READER);
    await a.cycle();
    expect((await a.task(t.id))?.deletedAt).toBeNull();
  });
});

describe('purge commune : enfants (revue Y2, point 11 ; décision (c))', () => {
  it('routine avec un journal (lien obligatoire) : écartée et journalisée ; projet avec une tâche vivante : tâche rattachée à « Sans projet », projet purgé', async () => {
    db = await openTestDb(SELF, '2026-10-05T08:00:00.000Z');
    const at = '2026-10-05T08:00:00.000Z';
    const h = `001791187200000-0000-${SELF}`;
    await db.driver.execute("INSERT INTO routine (id, space_id, title, schedule_type, start_date, created_at, updated_at, device_id, hlc) VALUES ('r1', ?, 'Lire', 'daily', '2026-10-01', ?, ?, ?, ?)", [PRO, at, at, SELF, h]);
    await db.driver.execute("INSERT INTO routine_log (id, routine_id, date, done_at, created_at, updated_at, device_id, hlc) VALUES ('l1', 'r1', '2026-10-03', ?, ?, ?, ?, ?)", [at, at, at, SELF, h]);
    await db.driver.execute("INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES ('p1', ?, 'P', '#123456', 1, ?, ?, ?, ?)", [PRO, at, at, SELF, h]);
    const [task] = await db.data.repos.tasks.createMany([{ ...newTask(1), projectId: 'p1' as never }]);
    const logger = createMemorySyncLogger();
    const moved: string[] = [];
    await guarded(db.data, async (repos) => {
      const routine = await purgeRows(repos, syncTable('routine') as SyncTable, [{ id: 'r1', deletedHlc: h as Hlc }], at as IsoDateTime, logger, { reattach: (_, ids) => moved.push(...ids) });
      expect(routine.purged).toEqual([]);
      const project = await purgeRows(repos, syncTable('project') as SyncTable, [{ id: 'p1', deletedHlc: h as Hlc }], at as IsoDateTime, logger, { reattach: (_, ids) => moved.push(...ids) });
      expect(project.purged.map((p) => p.id)).toEqual(['p1']);
    });
    expect(logger.entries.find((e) => e.event === 'purge-skipped')?.detail).toEqual({ table: 'routine', reason: 'live-children', count: 1 });
    expect(moved).toEqual([(task as { id: string }).id]);
    expect((await db.data.repos.tasks.getById((task as { id: TaskId }).id))?.projectId).toBeNull();
    expect(await db.driver.select("SELECT field FROM sync_outbox WHERE row_id = ? AND field = '+'", [(task as { id: string }).id])).toEqual([{ field: '+' }]);
    expect(await db.driver.select("SELECT field FROM sync_field_clock WHERE row_id = ? ORDER BY field", [(task as { id: string }).id])).toEqual([{ field: '*' }, { field: 'project_id' }]);
  });
});

describe('ligne existante qui reçoit un parent purgé (revue finale Y2, point 3 ; décision (c))', () => {
  it('projet purgé ici : la tâche existante est rattachée à « Sans projet » et republiée entière, rien n’est mis de côté', async () => {
    db = await openTestDb(SELF, '2026-10-05T08:00:00.000Z');
    const [task] = await db.data.repos.tasks.createMany([newTask(1)]);
    const id = (task as { id: TaskId }).id;
    await db.driver.execute('DELETE FROM sync_outbox');
    const purgedProject = '70000000-0000-4000-8000-000000000009';
    await db.data.repos.sync.insertTombstones([{ table: 'project', rowId: purgedProject, deletedHlc: `001791187000000-0000-${READER}` as Hlc }], '2026-10-05T08:00:00.000Z' as IsoDateTime);
    const logger = createMemorySyncLogger();
    // Hlc reçu déjà intégré par l’horloge locale (la lecture appelle hlc.receive avant d’appliquer) : plus ancien que l’heure locale.
    db.clock.advance(10_000);
    const remote = `001791187205000-0000-${READER}` as Hlc;
    const op = { t: 'task', id, at: '2026-10-05T08:00:00.000Z' as IsoDateTime, f: new Map([['project_id', [purgedProject, remote, null] as const]]) } as never;
    const result = await guarded(db.data, (repos) => applyOps(repos, [op], { localSv: 17, remoteSv: 17, now: '2026-10-05T08:00:00.000Z' as IsoDateTime, knows: () => false, logger }));
    expect(result.outcomes).toEqual(['applied']);
    expect((await db.data.repos.tasks.getById(id))?.projectId).toBeNull();
    expect(await db.driver.select('SELECT reason FROM sync_parked')).toEqual([]);
    expect(await db.driver.select("SELECT field FROM sync_outbox WHERE row_id = ?", [id])).toEqual([{ field: '+' }]);
    expect(logger.entries.some((e) => e.event === 'children-reattached')).toBe(true);
    const clock = (await db.driver.select<{ hlc: string }>("SELECT hlc FROM sync_field_clock WHERE row_id = ? AND field = 'project_id'", [id]))[0]?.hlc ?? '';
    expect(clock > remote).toBe(true);
  });
});
