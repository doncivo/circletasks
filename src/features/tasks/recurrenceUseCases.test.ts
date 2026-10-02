import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import type { RecurrenceFields, Task } from '../../domain/model';
import { defaultRecurrence } from '../../domain/recurrenceRules';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type LocalDate, type ReminderId, type TaskId } from '../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities, type TaskEntities } from '../app/taskEntities';
import { createUndoStack, type UndoStack } from '../app/undo';
import { createCarryOverUseCases } from './carryOverUseCases';
import { createTaskUseCases } from './createTaskUseCases';
import { createDayRollover } from './dayRollover';
import { createRecurrenceUseCases } from './recurrenceUseCases';
import type { TaskUseCaseDeps, TaskUseCases } from './taskUseCases';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('valeur attendue');
  return value;
}

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000009');
const d = (iso: string): LocalDate => asLocalDate(iso);
// Instant local sans fuseau : (mois 0-11, jour, heure).
const local = (m: number, day: number, h: number, min = 0) => new Date(2026, m, day, h, min).getTime();

const MONTHLY_23 = defaultRecurrence('monthly', d('2026-09-23'));

describe('récurrence des tâches (T-09), cas d’usage avec SQLite', () => {
  let db: TestDb;
  let deps: TaskUseCaseDeps;
  let useCases: TaskUseCases;
  let undo: UndoStack;
  let entities: TaskEntities;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, local(8, 23, 8));
    undo = createUndoStack();
    entities = createTaskEntities();
    deps = { clock: db.clock, ids: uuidGenerator, data: db.data, undo, taskEntities: entities };
    useCases = createTaskUseCases(deps);
  });
  afterEach(() => db.close());

  async function create(rule: RecurrenceFields | null, extra: Partial<Parameters<TaskUseCases['create']>[0]> = {}): Promise<Task> {
    const result = await useCases.create({
      title: 'Envoyer la facture',
      spaceId: SPACE_PRO_ID,
      date: d('2026-09-23'),
      ...(rule ? { recurrence: rule } : {}),
      ...extra,
    });
    if (!result.ok) throw new Error(`création impossible : ${result.error}`);
    return result.value;
  }

  const series = async (task: Task, includeDeleted = false) =>
    task.recurrenceId ? db.data.repos.tasks.listByRecurrence(task.recurrenceId, { includeDeleted }) : [];

  describe('création avec récurrence (critères 1 à 5)', () => {
    it('écrit la règle et la tâche (indice 0) ensemble', async () => {
      const task = await create(MONTHLY_23);
      expect(task.recurrenceId).not.toBeNull();
      expect(task.seriesIndex).toBe(0);
      const rule = await db.data.repos.recurrences.getById(must(task.recurrenceId));
      expect(rule).toMatchObject({ freq: 'monthly', interval: 1, monthDay: 23 });
    });

    it('refuse une récurrence sans date (« Un jour ») et une règle invalide, sans rien écrire', async () => {
      const someday = await useCases.create({ title: 'x', spaceId: SPACE_PRO_ID, someday: true, recurrence: MONTHLY_23 });
      expect(someday).toEqual({ ok: false, error: 'recurrence-needs-date' });
      const invalid = await useCases.create({ title: 'x', spaceId: SPACE_PRO_ID, date: d('2026-09-23'), recurrence: { ...defaultRecurrence('weekly', d('2026-09-23')), weekdays: [] } });
      expect(invalid).toEqual({ ok: false, error: 'recurrence-invalid' });
      expect(await db.data.repos.tasks.listForDay(d('2026-09-23'), 'all')).toEqual([]);
    });

    it('rend une tâche existante récurrente, une seule fois', async () => {
      const task = await create(null);
      const result = await useCases.setRecurrence(task.id, MONTHLY_23);
      expect(result.ok && result.value.seriesIndex).toBe(0);
      expect(entities.get(task.id)?.recurrenceId).not.toBeNull();
      expect(await useCases.setRecurrence(task.id, MONTHLY_23)).toEqual({ ok: false, error: 'already-recurrent' });
      const undated = await useCases.create({ title: 'Sans date', spaceId: SPACE_PRO_ID, date: null, someday: true });
      if (!undated.ok) throw new Error('création impossible');
      expect(await useCases.setRecurrence(undated.value.id, MONTHLY_23)).toEqual({ ok: false, error: 'needs-date' });
      expect(await useCases.setRecurrence(asEntityId<TaskId>('40000000-0000-4000-8000-0000000000aa'), MONTHLY_23)).toEqual({ ok: false, error: 'not-found' });
    });
  });

  describe('à la complétion (critères 7 à 9, 11)', () => {
    it('crée l’occurrence du 23 oct. avec les mêmes champs, rappels recopiés, indice + 1', async () => {
      const task = await create(MONTHLY_23, { note: 'PDF joint', time: asLocalTime('09:00'), icon: { kind: 'emoji', value: '🧾' } });
      await db.data.repos.reminders.replaceForTarget({ type: 'task', id: task.id }, [
        { id: asEntityId<ReminderId>('50000000-0000-4000-8000-000000000001'), targetType: 'task', targetId: task.id, offsetMin: 30, fireAt: '2026-09-23T08:30' as never },
      ]);

      await useCases.complete(task.id);

      const [first, next] = await series(task);
      expect(first?.status).toBe('done');
      expect(next).toMatchObject({
        title: 'Envoyer la facture',
        note: 'PDF joint',
        time: '09:00',
        icon: { kind: 'emoji', value: '🧾' },
        spaceId: SPACE_PRO_ID,
        date: '2026-10-23',
        status: 'todo',
        doneAt: null,
        seriesIndex: 1,
        recurrenceId: task.recurrenceId,
      });
      const reminders = await db.data.repos.reminders.listForTarget({ type: 'task', id: must(next).id });
      expect(reminders.map((r) => [r.offsetMin, r.fireAt])).toEqual([[30, '2026-10-23T08:30']]);
      expect(entities.get(must(next).id)?.date).toBe('2026-10-23'); // publiée dans taskEntities
    });

    it('hebdo lun. + jeu. terminée un lundi : la suivante est le jeudi', async () => {
      const rule = { ...defaultRecurrence('weekly', d('2026-09-21')), weekdays: [1, 4] } as RecurrenceFields;
      const task = await create(rule, { date: d('2026-09-21') });
      await useCases.complete(task.id);
      expect((await series(task))[1]?.date).toBe('2026-09-24');
    });

    it('tous les 3 jours : calcul depuis la date prévue ; terminée en avance, la suivante reste calculée depuis le 23', async () => {
      const rule = { ...defaultRecurrence('daily', d('2026-09-23')), interval: 3 };
      const task = await create(rule);
      db.clock.set(local(8, 20, 9)); // terminée le 20 pour le 23
      await useCases.complete(task.id);
      const [, next] = await series(task);
      expect(next?.date).toBe('2026-09-26');
      db.clock.set(local(8, 26, 9));
      await useCases.complete(must(next).id);
      expect((await series(task))[2]?.date).toBe('2026-09-29');
    });

    it('terminer deux fois (idempotent) ou après une suivante déjà créée ne crée pas de doublon (critère 12)', async () => {
      const task = await create(MONTHLY_23);
      await useCases.complete(task.id);
      await useCases.complete(task.id);
      await useCases.reopen(task.id);
      await useCases.complete(task.id);
      expect(await series(task)).toHaveLength(2);
    });

    it('une série à N occurrences s’arrête (count)', async () => {
      const task = await create({ ...MONTHLY_23, count: 1 });
      await useCases.complete(task.id);
      expect(await series(task)).toHaveLength(1);
    });
  });

  describe('annulation de la complétion (T-13)', () => {
    it('rouvre la tâche et supprime l’occurrence créée ; terminer à nouveau la recrée', async () => {
      const task = await create(MONTHLY_23, { time: asLocalTime('09:00') });
      await useCases.complete(task.id);
      const [, next] = await series(task);

      expect((await undo.undoLast()).status).toBe('undone');
      expect((await db.data.repos.tasks.getById(task.id))?.status).toBe('todo');
      expect(await db.data.repos.tasks.getById(must(next).id)).toBeNull();
      expect(entities.get(must(next).id)).toBeUndefined();
      expect(await series(task)).toHaveLength(1);
      expect(await db.data.repos.reminders.listForTarget({ type: 'task', id: must(next).id })).toEqual([]);

      await useCases.complete(task.id);
      const again = await series(task);
      expect(again).toHaveLength(2);
      expect(again[1]?.date).toBe('2026-10-23');
    });

    it('l’occurrence retirée par l’annulation n’est pas listée dans la corbeille (pas de doublon), mais sa suppression est conservée', async () => {
      const task = await create(MONTHLY_23);
      await useCases.complete(task.id);
      const [, next] = await series(task);
      await undo.undoLast();
      const trash = await db.data.repos.tasks.listTrash('2000-01-01T00:00:00.000Z' as never, 'all');
      expect(trash.map((t) => t.id)).not.toContain(must(next).id);
      expect((await db.data.repos.tasks.getById(must(next).id, { includeDeleted: true }))?.deletedAt).not.toBeNull();
    });

    it('occurrence créée modifiée entre-temps : « stale », rien n’est écrit', async () => {
      const task = await create(MONTHLY_23);
      await useCases.complete(task.id);
      const [, next] = await series(task);
      await useCases.update(must(next).id, { note: 'modifiée' });

      expect((await undo.undoLast()).status).toBe('stale');
      expect((await db.data.repos.tasks.getById(task.id))?.status).toBe('done');
      expect((await db.data.repos.tasks.getById(must(next).id))?.note).toBe('modifiée');
    });
  });

  describe('occurrence passée non faite (critères 10, 12, Q2)', () => {
    it('le jour passe : la suivante est créée au 23 oct. et l’occurrence du 23 sept. est reportée avec son badge, les deux coexistent', async () => {
      const task = await create(MONTHLY_23);
      db.clock.set(local(8, 24, 0, 5));
      await db.data.repos.settings.set('tasks.carryOverUndone', true);
      const rollover = createDayRollover({ clock: db.clock, ids: uuidGenerator, data: db.data, taskEntities: entities });
      await rollover.start();
      rollover.stop();

      const [first, next] = await series(task);
      expect(first).toMatchObject({ date: '2026-09-24', carriedOver: true, status: 'todo', seriesIndex: 0 });
      expect(next).toMatchObject({ date: '2026-10-23', carriedOver: false, status: 'todo', seriesIndex: 1 });
    });

    it('réglage de report désactivé : l’occurrence reste au 23 sept. et la suivante est créée quand même', async () => {
      const task = await create(MONTHLY_23);
      db.clock.set(local(8, 24, 0, 5));
      await db.data.repos.settings.set('tasks.carryOverUndone', false);
      await createRecurrenceUseCases(deps).generateDue();
      await createCarryOverUseCases(deps).run();
      const [first, next] = await series(task);
      expect(first).toMatchObject({ date: '2026-09-23', carriedOver: false });
      expect(next?.date).toBe('2026-10-23');
    });

    it('double déclenchement et redémarrages : aucun doublon (critère 12)', async () => {
      const task = await create(MONTHLY_23);
      db.clock.set(local(8, 24, 0, 5));
      const recurrence = createRecurrenceUseCases(deps);
      expect(await recurrence.generateDue()).toHaveLength(1);
      expect(await recurrence.generateDue()).toHaveLength(0);
      await createCarryOverUseCases(deps).run();
      db.clock.set(local(8, 25, 0, 5)); // le lendemain, l'occurrence reportée est encore à faire
      expect(await createRecurrenceUseCases(deps).generateDue()).toHaveLength(0);
      expect(await series(task)).toHaveLength(2);
    });

    it('une occurrence reportée terminée plus tard ne recrée pas de suivante', async () => {
      const task = await create(MONTHLY_23);
      db.clock.set(local(8, 24, 0, 5));
      await createRecurrenceUseCases(deps).generateDue();
      await createCarryOverUseCases(deps).run();
      await useCases.complete(task.id);
      expect(await series(task)).toHaveLength(2);
    });

    it('occurrence suivante mise à la corbeille : elle n’est pas recréée (corbeille comprise)', async () => {
      const task = await create(MONTHLY_23);
      db.clock.set(local(8, 24, 0, 5));
      const [next] = await createRecurrenceUseCases(deps).generateDue();
      await useCases.remove([must(next).id]);
      expect(await createRecurrenceUseCases(deps).generateDue()).toHaveLength(0);
      expect(await series(task)).toHaveLength(1);
      expect(await series(task, true)).toHaveLength(2);
    });

    it('rattrapage après une longue absence : une seule occurrence créée, à partir d’aujourd’hui, indice cohérent', async () => {
      const rule = { ...defaultRecurrence('daily', d('2026-09-23')), interval: 3 };
      const task = await create(rule);
      db.clock.set(local(9, 10, 8)); // 10 oct. : 26, 29, 2 oct., 5, 8 manquées, 11 oct. à venir
      const created = await createRecurrenceUseCases(deps).generateDue();
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ date: '2026-10-11', seriesIndex: 6 });
      expect(await series(task)).toHaveLength(2);
    });

    it('série à N occurrences épuisée pendant l’absence : aucune création', async () => {
      const rule = { ...defaultRecurrence('daily', d('2026-09-23')), count: 2 };
      await create(rule);
      db.clock.set(local(9, 30, 8));
      expect(await createRecurrenceUseCases(deps).generateDue()).toHaveLength(0);
    });

    it('QA : plusieurs redémarrages sur plusieurs jours via le rollover réel, une seule suivante (Q2, critère 12)', async () => {
      const task = await create(MONTHLY_23);
      await db.data.repos.settings.set('tasks.carryOverUndone', true);
      for (const [m, day] of [[8, 24], [8, 24], [8, 25], [8, 30], [9, 2]] as const) {
        db.clock.set(local(m, day, 0, 5));
        const rollover = createDayRollover({ clock: db.clock, ids: uuidGenerator, data: db.data, taskEntities: entities });
        await rollover.start();
        await rollover.check();
        rollover.stop();
      }
      const all = await series(task);
      expect(all).toHaveLength(2);
      expect(all[0]).toMatchObject({ date: '2026-10-02', carriedOver: true });
      expect(all[1]).toMatchObject({ date: '2026-10-23', seriesIndex: 1 });
    });

    it('QA : rappels recopiés à la génération au changement de jour', async () => {
      const task = await create(MONTHLY_23, { time: asLocalTime('09:00') });
      await db.data.repos.reminders.replaceForTarget({ type: 'task', id: task.id }, [
        { id: asEntityId<ReminderId>('50000000-0000-4000-8000-000000000002'), targetType: 'task', targetId: task.id, offsetMin: 60, fireAt: '2026-09-23T08:00' as never },
      ]);
      db.clock.set(local(8, 24, 0, 5));
      const [next] = await createRecurrenceUseCases(deps).generateDue();
      const reminders = await db.data.repos.reminders.listForTarget({ type: 'task', id: must(next).id });
      expect(reminders.map((r) => [r.offsetMin, r.fireAt])).toEqual([[60, '2026-10-23T08:00']]);
    });

    it('QA : suivante en corbeille puis complétion de l’occurrence reportée : pas de recréation', async () => {
      const task = await create(MONTHLY_23);
      db.clock.set(local(8, 24, 0, 5));
      const [next] = await createRecurrenceUseCases(deps).generateDue();
      await useCases.remove([must(next).id]);
      await useCases.complete(task.id);
      expect(await series(task)).toHaveLength(1);
      expect(await series(task, true)).toHaveLength(2);
    });

    it('QA : terminer, annuler, re-terminer : une seule suivante', async () => {
      const task = await create(MONTHLY_23);
      await useCases.complete(task.id);
      await undo.undoLast();
      await useCases.complete(task.id);
      // L'occurrence retirée par l'annulation est marquée (seriesIndex < 0) : hors série vivante.
      expect((await series(task, true)).filter((t) => (t.seriesIndex ?? 0) >= 0)).toHaveLength(2);
    });

    it('QA : filtre d’espace, Pro ne voit pas la suivante Perso', async () => {
      const task = await create(MONTHLY_23, { spaceId: SPACE_PERSO_ID });
      await useCases.complete(task.id);
      const next = must((await series(task))[1]);
      expect((await db.data.repos.tasks.listForDay(next.date as LocalDate, SPACE_PRO_ID)).map((t) => t.id)).not.toContain(next.id);
      expect((await db.data.repos.tasks.listForDay(next.date as LocalDate, SPACE_PERSO_ID)).map((t) => t.id)).toContain(next.id);
    });

    it('espace et filtre : l’occurrence créée garde l’espace Perso', async () => {
      const task = await create(MONTHLY_23, { spaceId: SPACE_PERSO_ID });
      await useCases.complete(task.id);
      expect((await series(task))[1]?.spaceId).toBe(SPACE_PERSO_ID);
    });
  });
});
