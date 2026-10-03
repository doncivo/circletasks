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

  let seq = 0;
  async function seedGoal(weekStartValue: string, extra: { title?: string; spaceId?: typeof SPACE_PRO_ID; status?: 'open' | 'achieved' | 'closed'; carriedFromId?: GoalId } = {}): Promise<GoalId> {
    seq += 1;
    db.clock.advance(1);
    const id = asEntityId<GoalId>(`c1000000-0000-4000-8000-${String(seq).padStart(12, '0')}`);
    await db.data.repos.goals.create({
      id,
      spaceId: extra.spaceId ?? SPACE_PRO_ID,
      weekStart: asLocalDate(weekStartValue),
      title: extra.title ?? `Objectif ${weekStartValue}`,
      icon: null,
      pinned: false,
      status: extra.status ?? 'closed',
      carriedFromId: extra.carriedFromId ?? null,
    });
    return id;
  }

  it('listBefore rend une page de 20 semaines, du plus récent au plus ancien, sans la semaine donnée (OB-06 critère 7)', async () => {
    const weeks: string[] = [];
    let cursor = Date.UTC(2023, 9, 2);
    for (let i = 0; i < 150; i += 1) {
      weeks.push(new Date(cursor).toISOString().slice(0, 10));
      cursor += 7 * 86_400_000;
    }
    for (const week of weeks) await seedGoal(week);
    const current = asLocalDate(weeks[149] as string);
    const first = await db.data.repos.goals.listBefore(current, 'all');
    expect(first).toHaveLength(20);
    expect(first[0]?.weekStart).toBe(weeks[148]);
    expect(first.at(-1)?.weekStart).toBe(weeks[129]);
    const second = await db.data.repos.goals.listBefore(first.at(-1)?.weekStart as never, 'all');
    expect(second).toHaveLength(20);
    expect(second[0]?.weekStart).toBe(weeks[128]);
  });

  it('listBefore regroupe plusieurs objectifs d’une semaine et applique le filtre d’espace', async () => {
    await seedGoal('2026-09-14');
    await seedGoal('2026-09-21');
    await seedGoal('2026-09-21', { title: 'Perso', spaceId: SPACE_PERSO_ID });
    const all = await db.data.repos.goals.listBefore(asLocalDate('2026-09-28'), 'all');
    expect(all.map((g) => g.weekStart)).toEqual(['2026-09-21', '2026-09-21', '2026-09-14']);
    expect((await db.data.repos.goals.listBefore(asLocalDate('2026-09-28'), SPACE_PERSO_ID)).map((g) => g.title)).toEqual(['Perso']);
    expect(await db.data.repos.goals.listBefore(asLocalDate('2026-09-14'), 'all')).toEqual([]);
  });

  it('listOpenBefore ne rend que les objectifs ouverts d’une semaine antérieure', async () => {
    await seedGoal('2026-09-14', { status: 'closed' });
    await seedGoal('2026-09-21', { status: 'open' });
    await seedGoal('2026-09-28', { status: 'open', title: 'Courant' });
    const open = await db.data.repos.goals.listOpenBefore(asLocalDate('2026-09-28'));
    expect(open.map((g) => g.title)).toEqual(['Objectif 2026-09-21']);
  });

  it('listCarriedFrom retrouve les objectifs reconduits (OB-06 critère 5)', async () => {
    const oldId = await seedGoal('2026-09-21');
    const next = await seedGoal('2026-09-28', { status: 'open', carriedFromId: oldId });
    expect((await db.data.repos.goals.listCarriedFrom([oldId])).map((g) => g.id)).toEqual([next]);
    expect(await db.data.repos.goals.listCarriedFrom([])).toEqual([]);
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
