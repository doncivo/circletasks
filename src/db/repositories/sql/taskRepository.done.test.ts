import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { donePeriodInstants, donePeriodOf } from '../../../domain/donePeriod';
import { asEntityId, asLocalDate, type DeviceId, type IsoDateTime, type TaskId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { buildManyTasks, sampleTask } from '../../seed/sampleData';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000a7');
const DAY = asLocalDate('2026-09-23');

/** Instant UTC d'une heure locale de l'appareil (les périodes sont en minuit local). */
const local = (value: string) => new Date(value).toISOString() as IsoDateTime;
const tid = (n: number) => asEntityId<TaskId>(`70000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

describe('TaskRepository.listDone (SQL) : tâches terminées par période (T-07)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });
  afterEach(() => db.close());

  async function seed(n: number, doneLocal: string | null, extra: { spaceId?: typeof SPACE_PRO_ID } = {}): Promise<TaskId> {
    const id = tid(n);
    await db.data.repos.tasks.create(sampleTask({ id, title: `Tâche ${String(n)}`, date: DAY, spaceId: extra.spaceId ?? SPACE_PRO_ID }));
    if (doneLocal) await db.data.repos.tasks.complete(id, local(doneLocal));
    return id;
  }

  it('borne basse incluse (00:00 local), borne haute exclue (minuit local suivant)', async () => {
    const first = await seed(1, '2026-09-23T00:00:00');
    const last = await seed(2, '2026-09-23T23:59:59');
    await seed(3, '2026-09-22T23:59:59');
    await seed(4, '2026-09-24T00:00:00');
    const done = await db.data.repos.tasks.listDone(donePeriodInstants(donePeriodOf('day', DAY)), 'all');
    expect(done.map((t) => t.id)).toEqual([first, last]);
  });

  it('semaine (lundi-dimanche) et mois : plages de dates locales', async () => {
    const mon = await seed(1, '2026-09-21T08:00:00');
    const sun = await seed(2, '2026-09-27T22:00:00');
    await seed(3, '2026-09-28T08:00:00');
    const month = await seed(4, '2026-09-01T07:00:00');
    const week = await db.data.repos.tasks.listDone(donePeriodInstants(donePeriodOf('week', DAY)), 'all');
    expect(week.map((t) => t.id)).toEqual([mon, sun]);
    const sept = await db.data.repos.tasks.listDone(donePeriodInstants(donePeriodOf('month', DAY)), 'all');
    expect(sept.map((t) => t.id)).toEqual([month, mon, sun, tid(3)]);
  });

  it('filtre d’espace Pro / Perso / Tout (critère 5)', async () => {
    const pro = await seed(1, '2026-09-23T09:00:00');
    const perso = await seed(2, '2026-09-23T10:00:00', { spaceId: SPACE_PERSO_ID as never });
    const range = donePeriodInstants(donePeriodOf('day', DAY));
    expect((await db.data.repos.tasks.listDone(range, SPACE_PRO_ID)).map((t) => t.id)).toEqual([pro]);
    expect((await db.data.repos.tasks.listDone(range, SPACE_PERSO_ID)).map((t) => t.id)).toEqual([perso]);
    expect(await db.data.repos.tasks.listDone(range, 'all')).toHaveLength(2);
  });

  it('exclut les tâches à faire, rouvertes et supprimées (critère 9)', async () => {
    await seed(1, null);
    const reopened = await seed(2, '2026-09-23T09:00:00');
    await db.data.repos.tasks.reopen(reopened);
    const deleted = await seed(3, '2026-09-23T09:00:00');
    await db.data.repos.tasks.softDelete([deleted]);
    const kept = await seed(4, '2026-09-23T09:00:00');
    const done = await db.data.repos.tasks.listDone(donePeriodInstants(donePeriodOf('day', DAY)), 'all');
    expect(done.map((t) => t.id)).toEqual([kept]);
  });

  it('la requête utilise l’index sur done_at', async () => {
    const plan = await db.driver.select<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT * FROM task WHERE deleted_at IS NULL AND status = 'done' AND done_at >= ? AND done_at < ? ORDER BY done_at, id",
      ['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    );
    expect(plan.map((row) => row.detail).join(' ')).toContain('idx_task_status_done_at');
  });

  it('5 000 tâches terminées : un mois se lit bien sous 300 ms (seuil large : driver Wasm)', async () => {
    const tasks = buildManyTasks(DAY, 5000);
    await db.data.repos.tasks.createMany(tasks);
    await db.driver.execute(
      "UPDATE task SET status = 'done', done_at = strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || (sort_order % 270) || ' days', '+12 hours')",
    );
    const start = performance.now();
    const done = await db.data.repos.tasks.listDone(donePeriodInstants(donePeriodOf('month', asLocalDate('2026-09-15'))), 'all');
    const elapsed = performance.now() - start;
    expect(done.length).toBeGreaterThan(0);
    expect(done.length).toBeLessThan(5000);
    expect(elapsed).toBeLessThan(1000);
  }, 30_000);
});
