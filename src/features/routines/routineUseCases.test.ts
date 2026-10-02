import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { newEntityId } from '../../domain/id';
import type { RoutineFields } from '../../domain/model';
import { asEntityId, type DeviceId, type LocalDate, type RoutineId, type RoutineLogId, type SpaceId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createAppContainer, type AppContainer } from '../app/container';
import { createRoutineUseCases } from './routineUseCases';

// Aujourd'hui : ven. 2 oct. 2026 ; semaine du lun. 28 sept. au dim. 4 oct.
const date = (iso: string) => iso as LocalDate;
const WEEK = { from: date('2026-09-28'), to: date('2026-10-04') };

function fields(overrides: Partial<RoutineFields> = {}): RoutineFields {
  return {
    spaceId: SPACE_PRO_ID as SpaceId,
    title: 'Faire mon lit',
    icon: null,
    scheduleType: 'daily',
    weekdays: [],
    timesPerWeek: null,
    interval: null,
    startDate: date('2026-09-01'),
    time: null,
    paused: false,
    archived: false,
    ...overrides,
  };
}

describe('cas d’usage des routines : validation (R-03)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    const device = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000301');
    db = await openTestDb(device, '2026-10-02T10:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: device }), data: db.data });
  });
  afterEach(() => db.close());

  const cases = () => createRoutineUseCases(container);
  const logsOf = async (id: RoutineId) => db.data.repos.routineLogs.listForRoutine(id, WEEK);

  async function create(overrides: Partial<RoutineFields> = {}): Promise<RoutineId> {
    const result = await cases().create({ fields: fields(overrides), reminderOffsets: [] });
    if (!result.ok) throw new Error(result.error);
    return result.value.id as RoutineId;
  }

  it('valide un jour : une ligne routine_log avec la date et done_at (critère 1)', async () => {
    const id = await create();
    expect(await cases().setDone(id, date('2026-10-02'), true)).toBe('validated');
    const logs = await logsOf(id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ routineId: id, date: '2026-10-02', doneAt: '2026-10-02T10:00:00.000Z' });
  });

  it('une seule validation par jour : une seconde est ignorée, même en parallèle (critère 3)', async () => {
    const id = await create();
    const results = await Promise.all([cases().setDone(id, date('2026-10-02'), true), cases().setDone(id, date('2026-10-02'), true)]);
    expect(results).toContain('validated');
    expect(await logsOf(id)).toHaveLength(1);
    expect(await cases().setDone(id, date('2026-10-02'), true)).toBe('ignored');
    expect(await logsOf(id)).toHaveLength(1);
  });

  it('synchro simulée : deux appareils valident le même jour, une seule ligne en base (critère 3)', async () => {
    const id = await create();
    const repo = db.data.repos.routineLogs;
    await repo.markDone(id, date('2026-10-01'), '2026-10-01T08:00:00.000Z' as never, newEntityId<RoutineLogId>(container.ids));
    db.clock.advance(5);
    await repo.markDone(id, date('2026-10-01'), '2026-10-01T09:00:00.000Z' as never, newEntityId<RoutineLogId>(container.ids));
    expect(await logsOf(id)).toHaveLength(1);
  });

  it('rouvrir retire la validation (suppression logique) et la relance recrée la ligne au même id (critère 2)', async () => {
    const id = await create();
    await cases().setDone(id, date('2026-10-02'), true);
    const [first] = await logsOf(id);
    expect(await cases().setDone(id, date('2026-10-02'), false)).toBe('reopened');
    expect(await logsOf(id)).toEqual([]);
    expect(await cases().setDone(id, date('2026-10-02'), false)).toBe('ignored');
    await cases().setDone(id, date('2026-10-02'), true);
    const [again] = await logsOf(id);
    expect(again?.id).toBe(first?.id);
  });

  it('l’historique de la veille reste quand on valide le lendemain (critère 5)', async () => {
    const id = await create();
    await cases().setDone(id, date('2026-10-01'), true);
    await cases().setDone(id, date('2026-10-02'), true);
    expect((await logsOf(id)).map((log) => log.date)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('refuse un jour futur, un jour non prévu, avant le départ, une routine en pause ou archivée, inconnue (QB-03)', async () => {
    const id = await create();
    expect(await cases().setDone(id, date('2026-10-03'), true)).toBe('ignored'); // demain
    const sport = await create({ scheduleType: 'weekdays', weekdays: [1, 3, 5] });
    expect(await cases().setDone(sport, date('2026-10-01'), true)).toBe('ignored'); // jeudi non prévu
    expect(await cases().setDone(sport, date('2026-09-30'), true)).toBe('validated'); // mercredi prévu, rattrapage
    const late = await create({ startDate: date('2026-10-01') });
    expect(await cases().setDone(late, date('2026-09-30'), true)).toBe('ignored'); // avant le départ
    const paused = await create({ paused: true });
    expect(await cases().setDone(paused, date('2026-10-02'), true)).toBe('ignored');
    const archived = await create({ archived: true });
    expect(await cases().setDone(archived, date('2026-10-02'), true)).toBe('ignored');
    expect(await cases().setDone(asEntityId<RoutineId>('80000000-0000-4000-8000-0000000000ff'), date('2026-10-02'), true)).toBe('ignored');
    expect(await logsOf(id)).toEqual([]);
  });

  it('« 3 fois par semaine » : pas de 4e validation, on peut rouvrir un jour (critère 12, QB-01)', async () => {
    const id = await create({ scheduleType: 'x_per_week', timesPerWeek: 3 });
    for (const day of ['2026-09-28', '2026-09-29', '2026-09-30']) expect(await cases().setDone(id, date(day), true)).toBe('validated');
    expect(await cases().setDone(id, date('2026-10-01'), true)).toBe('ignored');
    expect(await logsOf(id)).toHaveLength(3);
    expect(await cases().setDone(id, date('2026-09-29'), false)).toBe('reopened');
    expect(await cases().setDone(id, date('2026-10-01'), true)).toBe('validated');
  });

  describe('annulation 5 s (T-13)', () => {
    it('annuler une validation la retire ; stale si elle a été modifiée depuis', async () => {
      const id = await create();
      await cases().setDone(id, date('2026-10-02'), true);
      expect(container.undo.getSnapshot().top).toMatchObject({ kind: 'routine', labelKey: 'routines.undo.validated', labelParams: { title: 'Faire mon lit' } });
      expect((await container.undo.undoLast()).status).toBe('undone');
      expect(await logsOf(id)).toEqual([]);

      await cases().setDone(id, date('2026-10-02'), true);
      // Modifiée entre-temps (synchro, autre appareil) : nouveau hlc.
      db.clock.advance(10);
      await db.data.repos.routineLogs.markDone(id, date('2026-10-02'), '2026-10-02T11:00:00.000Z' as never, newEntityId<RoutineLogId>(container.ids));
      expect((await container.undo.undoLast()).status).toBe('stale');
      expect(await logsOf(id)).toHaveLength(1);
    });

    it('annuler une réouverture revalide le jour ; stale s’il l’a été entre-temps', async () => {
      const id = await create();
      await cases().setDone(id, date('2026-10-02'), true);
      container.undo.clear();
      await cases().setDone(id, date('2026-10-02'), false);
      expect(container.undo.getSnapshot().top).toMatchObject({ labelKey: 'routines.undo.reopened' });
      expect((await container.undo.undoLast()).status).toBe('undone');
      expect(await logsOf(id)).toHaveLength(1);

      await cases().setDone(id, date('2026-10-02'), false);
      await db.data.repos.routineLogs.markDone(id, date('2026-10-02'), '2026-10-02T12:00:00.000Z' as never, newEntityId<RoutineLogId>(container.ids));
      expect((await container.undo.undoLast()).status).toBe('stale');
    });

    it('une action ignorée ne pousse aucune commande', async () => {
      const id = await create();
      await cases().setDone(id, date('2026-10-03'), true);
      expect(container.undo.getSnapshot().size).toBe(0);
    });
  });

  it('création et modification : titre invalide refusé ; la modification garde les validations (R-07 critère 8)', async () => {
    expect(await cases().create({ fields: fields({ title: '  ' }), reminderOffsets: [] })).toEqual({ ok: false, error: 'empty-title' });
    const id = await create({ scheduleType: 'every_n_days', interval: 3, startDate: date('2026-09-26') });
    await cases().setDone(id, date('2026-09-29'), true);
    const updated = await cases().update(id, { fields: fields({ scheduleType: 'every_n_days', interval: 4, startDate: date('2026-09-26') }), reminderOffsets: [] });
    expect(updated).toMatchObject({ ok: true, value: { interval: 4 } });
    expect((await logsOf(id)).map((log) => log.date)).toEqual(['2026-09-29']);
    expect(await cases().update(id, { fields: fields({ title: '' }), reminderOffsets: [] })).toEqual({ ok: false, error: 'empty-title' });
  });
});
