import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asEntityId, asLocalDate, type DeviceId, type GoalId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000005');
const goalId = asEntityId<GoalId>('c0000000-0000-4000-8000-000000000001');
const weekStart = asLocalDate('2026-10-05');

describe('GoalRepository (SQL)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('crée, édite et clôt un objectif de la semaine (M17, OB-01, OB-02)', async () => {
    const created = await db.data.repos.goals.create({
      id: goalId,
      spaceId: SPACE_PRO_ID,
      weekStart,
      title: 'Clôturer le trimestre',
      icon: { kind: 'emoji', value: '🎯' },
      pinned: true,
      status: 'open',
      carriedFromId: null,
    });
    expect(created.pinned).toBe(true);

    const updated = await db.data.repos.goals.update(goalId, { title: 'Clôturer le trimestre Q4' });
    expect(updated.title).toBe('Clôturer le trimestre Q4');

    const achieved = await db.data.repos.goals.setStatus(goalId, 'achieved');
    expect(achieved.status).toBe('achieved');
  });

  it('listForWeek filtre par semaine et par espace', async () => {
    await db.data.repos.goals.create({
      id: goalId,
      spaceId: SPACE_PRO_ID,
      weekStart,
      title: 'Objectif Pro',
      icon: null,
      pinned: false,
      status: 'open',
      carriedFromId: null,
    });
    const other = asEntityId<GoalId>('c0000000-0000-4000-8000-000000000002');
    await db.data.repos.goals.create({
      id: other,
      spaceId: SPACE_PERSO_ID,
      weekStart,
      title: 'Objectif Perso',
      icon: null,
      pinned: false,
      status: 'open',
      carriedFromId: null,
    });
    expect(await db.data.repos.goals.listForWeek(weekStart, 'all')).toHaveLength(2);
    expect(await db.data.repos.goals.listForWeek(weekStart, SPACE_PRO_ID)).toHaveLength(1);
    expect(await db.data.repos.goals.listForWeek(asLocalDate('2026-10-12'), 'all')).toEqual([]);
  });

  it('listHistory couvre une plage de week_start, du plus récent au plus ancien (OB-06)', async () => {
    const weekBefore = asLocalDate('2026-09-28');
    const other = asEntityId<GoalId>('c0000000-0000-4000-8000-000000000003');
    await db.data.repos.goals.create({
      id: goalId,
      spaceId: SPACE_PRO_ID,
      weekStart,
      title: 'Récent',
      icon: null,
      pinned: false,
      status: 'open',
      carriedFromId: null,
    });
    await db.data.repos.goals.create({
      id: other,
      spaceId: SPACE_PRO_ID,
      weekStart: weekBefore,
      title: 'Ancien',
      icon: null,
      pinned: false,
      status: 'closed',
      carriedFromId: null,
    });
    const history = await db.data.repos.goals.listHistory({ from: weekBefore, to: weekStart }, 'all');
    expect(history.map((g) => g.id)).toEqual([goalId, other]);
  });

  it('softDelete puis restore', async () => {
    await db.data.repos.goals.create({
      id: goalId,
      spaceId: SPACE_PRO_ID,
      weekStart,
      title: 'Objectif',
      icon: null,
      pinned: false,
      status: 'open',
      carriedFromId: null,
    });
    const deleted = await db.data.repos.goals.softDelete(goalId);
    expect(deleted.deletedAt).not.toBeNull();
    expect(await db.data.repos.goals.getById(goalId)).toBeNull();
    const restored = await db.data.repos.goals.restore(goalId);
    expect(restored.deletedAt).toBeNull();
  });
});
