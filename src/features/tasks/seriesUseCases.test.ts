import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidGenerator } from '../../domain/id';
import type { RecurrenceFields, Task } from '../../domain/model';
import { defaultRecurrence } from '../../domain/recurrenceRules';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type IsoDateTime, type LocalDate, type TaskId } from '../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities, type TaskEntities } from '../app/taskEntities';
import { createUndoStack, type UndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';
import { createDayRollover } from './dayRollover';
import { createSeriesUseCases, type SeriesUseCases } from './seriesUseCases';
import type { TaskUseCaseDeps, TaskUseCases } from './taskUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000010');
const d = (iso: string): LocalDate => asLocalDate(iso);
// Instant local sans fuseau : (mois 0-11, jour, heure, minute).
const local = (m: number, day: number, h: number, min = 0) => new Date(2026, m, day, h, min).getTime();
const EPOCH = '2026-01-01T00:00:00.000Z' as IsoDateTime;
const UNKNOWN = asEntityId<TaskId>('99999999-0000-4000-8000-000000000001');

const MONTHLY_23 = defaultRecurrence('monthly', d('2026-09-23'));
const EVERY_3_DAYS: RecurrenceFields = { ...defaultRecurrence('daily', d('2026-09-23')), interval: 3 };

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('valeur attendue');
  return value;
}

describe('modifier ou arrêter une récurrence (T-10), cas d’usage avec SQLite', () => {
  let db: TestDb;
  let deps: TaskUseCaseDeps;
  let tasks: TaskUseCases;
  let series: SeriesUseCases;
  let undo: UndoStack;
  let entities: TaskEntities;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, local(8, 23, 8));
    undo = createUndoStack();
    entities = createTaskEntities();
    deps = { clock: db.clock, ids: uuidGenerator, data: db.data, undo, taskEntities: entities };
    tasks = createTaskUseCases(deps);
    series = createSeriesUseCases(deps);
  });
  afterEach(() => db.close());

  async function create(rule: RecurrenceFields = MONTHLY_23, extra: Partial<Parameters<TaskUseCases['create']>[0]> = {}): Promise<Task> {
    const result = await tasks.create({ title: 'Payer le loyer', spaceId: SPACE_PRO_ID, date: d('2026-09-23'), recurrence: rule, ...extra });
    if (!result.ok) throw new Error(`création impossible : ${result.error}`);
    return result.value;
  }

  async function createSimple(): Promise<Task> {
    const result = await tasks.create({ title: 'Simple', spaceId: SPACE_PRO_ID, date: d('2026-09-23') });
    if (!result.ok) throw new Error(`création impossible : ${result.error}`);
    return result.value;
  }

  /** Occurrences de la série de `task`, par rang (supprimées comprises avec `includeDeleted`). */
  const all = (task: Task, includeDeleted = false) => db.data.repos.tasks.listByRecurrence(must(task.recurrenceId), { includeDeleted });
  const get = async (id: TaskId) => must(await db.data.repos.tasks.getById(id));
  const ruleOf = (task: Task) => db.data.repos.recurrences.getById(must(task.recurrenceId));
  const trash = () => db.data.repos.tasks.listTrash(EPOCH, 'all');

  /** Termine `task` et rend l'occurrence suivante créée. */
  async function completeAndNext(task: Task): Promise<Task> {
    await tasks.complete(task.id);
    return must((await all(task)).find((t) => t.seriesIndex === (task.seriesIndex ?? 0) + 1));
  }

  async function runRollover(): Promise<void> {
    const rollover = createDayRollover({ clock: db.clock, ids: uuidGenerator, data: db.data, taskEntities: entities });
    await rollover.start();
    rollover.stop();
  }

  describe('« Cette occurrence » (critères 1, 2)', () => {
    it('seule la tâche courante change ; la suivante reprend les valeurs de la série', async () => {
      const task = await create(MONTHLY_23, { time: asLocalTime('09:00'), note: 'virement' });
      const result = await series.updateOccurrence(task.id, { title: 'Loyer (exception)', note: 'chèque', time: asLocalTime('11:30') }, 'occurrence');
      expect(result).toMatchObject({ ok: true, value: { title: 'Loyer (exception)', note: 'chèque', time: '11:30' } });
      expect(await get(task.id)).toMatchObject({ seriesTemplate: { title: 'Payer le loyer', note: 'virement', time: '09:00' } });

      const next = await completeAndNext(task);
      expect(next).toMatchObject({ title: 'Payer le loyer', note: 'virement', time: '09:00', date: '2026-10-23', seriesIndex: 1, seriesTemplate: null });
    });

    it('espace et icône sont des valeurs de la série aussi', async () => {
      const task = await create();
      await series.updateOccurrence(task.id, { spaceId: SPACE_PERSO_ID, icon: { kind: 'emoji', value: '🏠' } }, 'occurrence');
      const next = await completeAndNext(task);
      expect(next).toMatchObject({ spaceId: SPACE_PRO_ID, icon: null });
      expect(await get(task.id)).toMatchObject({ spaceId: SPACE_PERSO_ID, icon: { kind: 'emoji', value: '🏠' } });
    });

    it('un déplacement de date ne décale pas la série (ancre d’origine)', async () => {
      const task = await create(EVERY_3_DAYS);
      await series.updateOccurrence(task.id, { date: d('2026-09-25') }, 'occurrence');
      expect((await completeAndNext(task)).date).toBe('2026-09-26'); // 23 + 3, pas 25 + 3
    });

    it('une deuxième modification garde les valeurs d’origine de la série', async () => {
      const task = await create();
      await series.updateOccurrence(task.id, { title: 'Exception A' }, 'occurrence');
      await series.updateOccurrence(task.id, { title: 'Exception B' }, 'occurrence');
      expect(await get(task.id)).toMatchObject({ title: 'Exception B', seriesTemplate: { title: 'Payer le loyer' } });
      expect((await completeAndNext(task)).title).toBe('Payer le loyer');
    });

    it('annulable : « Annuler » remet la tâche et efface l’écart', async () => {
      const task = await create();
      await series.updateOccurrence(task.id, { title: 'Exception' }, 'occurrence');
      expect(undo.getSnapshot().top).toMatchObject({ kind: 'series', labelKey: 'undo.seriesOccurrence' });
      expect((await undo.undoLast()).status).toBe('undone');
      expect(await get(task.id)).toMatchObject({ title: 'Payer le loyer', seriesTemplate: null });
      expect(entities.get(task.id)?.title).toBe('Payer le loyer');
    });
  });

  describe('« Toutes les suivantes » (critère 3)', () => {
    it('la tâche change et la série reprend les valeurs : la suivante les reçoit', async () => {
      const task = await create();
      await series.updateOccurrence(task.id, { title: 'Loyer appartement', note: 'nouveau bail' }, 'following');
      expect(await get(task.id)).toMatchObject({ title: 'Loyer appartement', seriesTemplate: null });
      expect(await completeAndNext(task)).toMatchObject({ title: 'Loyer appartement', note: 'nouveau bail', date: '2026-10-23' });
    });

    it('l’occurrence à venir déjà créée suit ; la terminée n’est pas touchée', async () => {
      const first = await create();
      const second = await completeAndNext(first); // 23 oct. ; la première est terminée
      await series.updateOccurrence(second.id, { title: 'Loyer 2' }, 'following');
      expect((await get(first.id)).title).toBe('Payer le loyer');

      await series.updateOccurrence(first.id, { note: 'rappel' }, 'following');
      expect(await get(second.id)).toMatchObject({ title: 'Loyer 2', note: 'rappel' });
    });

    it('les occurrences terminées après la courante restent inchangées', async () => {
      const first = await create();
      const second = await completeAndNext(first);
      const third = await completeAndNext(second);
      await tasks.complete(third.id);
      await series.updateOccurrence(first.id, { title: 'Nouveau titre' }, 'following');
      expect((await get(first.id)).title).toBe('Nouveau titre');
      expect((await get(second.id)).title).toBe('Payer le loyer');
      expect((await get(third.id)).title).toBe('Payer le loyer');
    });

    it('la date déplacée devient la référence de la série', async () => {
      const task = await create(EVERY_3_DAYS);
      await series.updateOccurrence(task.id, { date: d('2026-09-25') }, 'following');
      expect((await completeAndNext(task)).date).toBe('2026-09-28');
    });

    it('annulable, y compris sur les occurrences à venir', async () => {
      const first = await create();
      const second = await completeAndNext(first);
      await series.updateOccurrence(first.id, { title: 'Autre' }, 'following');
      expect((await get(second.id)).title).toBe('Autre');
      expect(undo.getSnapshot().top).toMatchObject({ labelKey: 'undo.seriesFollowing' });
      expect((await undo.undoLast()).status).toBe('undone');
      expect((await get(second.id)).title).toBe('Payer le loyer');
      expect((await get(first.id)).title).toBe('Payer le loyer');
    });

    it('efface l’écart d’une occurrence déjà détachée', async () => {
      const task = await create();
      await series.updateOccurrence(task.id, { title: 'Exception' }, 'occurrence');
      await series.updateOccurrence(task.id, { title: 'Définitif' }, 'following');
      expect(await get(task.id)).toMatchObject({ title: 'Définitif', seriesTemplate: null });
      expect((await completeAndNext(task)).title).toBe('Définitif');
    });
  });

  describe('erreurs et cas sans effet', () => {
    it('tâche inconnue ou simple, titre vide ou trop long, date effacée', async () => {
      const task = await create();
      const simple = await createSimple();
      expect(await series.updateOccurrence(UNKNOWN, { note: 'x' }, 'occurrence')).toEqual({ ok: false, error: 'not-found' });
      expect(await series.updateOccurrence(simple.id, { note: 'x' }, 'occurrence')).toEqual({ ok: false, error: 'not-recurrent' });
      expect(await series.updateOccurrence(task.id, { title: '   ' }, 'occurrence')).toEqual({ ok: false, error: 'empty-title' });
      expect(await series.updateOccurrence(task.id, { title: 'x'.repeat(201) }, 'following')).toEqual({ ok: false, error: 'title-too-long' });
      expect(await series.updateOccurrence(task.id, { date: null }, 'occurrence')).toEqual({ ok: false, error: 'needs-date' });
      expect(await get(task.id)).toMatchObject({ title: 'Payer le loyer', seriesTemplate: null });
      expect(undo.getSnapshot().size).toBe(0);
    });

    it('aucun changement réel : rien n’est écrit ni annulable', async () => {
      const task = await create();
      const result = await series.updateOccurrence(task.id, { title: 'Payer le loyer', note: '' }, 'occurrence');
      expect(result.ok).toBe(true);
      expect((await get(task.id)).hlc).toBe(task.hlc);
      expect(undo.getSnapshot().size).toBe(0);
    });

    it('un « Annuler » périmé (tâche modifiée depuis) ne réécrit rien', async () => {
      const task = await create();
      await series.updateOccurrence(task.id, { title: 'Exception' }, 'occurrence');
      await tasks.update(task.id, { note: 'plus tard' });
      expect((await undo.undoLast()).status).toBe('stale');
      expect(await get(task.id)).toMatchObject({ title: 'Exception', note: 'plus tard' });
    });
  });

  describe('fin de la série : date ou nombre d’occurrences (critères 5, 8, 9)', () => {
    it('« Fin le 31 déc. 2026 » : aucune occurrence créée après cette date', async () => {
      const task = await create();
      const rule = await series.updateRule(task.id, { ...MONTHLY_23, until: d('2026-12-31') });
      expect(rule).toMatchObject({ ok: true, value: { until: '2026-12-31', count: null } });
      let current = task;
      for (const date of ['2026-10-23', '2026-11-23', '2026-12-23']) {
        current = await completeAndNext(current);
        expect(current.date).toBe(date);
      }
      await tasks.complete(current.id);
      expect((await all(task)).map((t) => t.date)).toEqual(['2026-09-23', '2026-10-23', '2026-11-23', '2026-12-23']);
    });

    it('la date de fin est incluse', async () => {
      const task = await create();
      await series.updateRule(task.id, { ...MONTHLY_23, until: d('2026-10-23') });
      const second = await completeAndNext(task);
      await tasks.complete(second.id);
      expect(await all(task)).toHaveLength(2);
    });

    it('« Après 6 occurrences » : la 6ᵉ terminée ne crée pas de 7ᵉ', async () => {
      const task = await create(EVERY_3_DAYS);
      await series.updateRule(task.id, { ...EVERY_3_DAYS, count: 6 });
      let current = task;
      for (let n = 1; n < 6; n++) current = await completeAndNext(current);
      expect(current.seriesIndex).toBe(5);
      await tasks.complete(current.id);
      const list = await all(task);
      expect(list).toHaveLength(6);
      expect(list.at(-1)?.date).toBe('2026-10-08');
    });

    it('la dernière occurrence passée (non terminée) ne crée pas de suivante non plus', async () => {
      const task = await create(EVERY_3_DAYS);
      await series.updateRule(task.id, { ...EVERY_3_DAYS, count: 2 });
      const second = await completeAndNext(task);
      db.clock.set(local(8, 30, 0, 5));
      await runRollover();
      expect(await all(task)).toHaveLength(2);
      expect((await get(second.id)).seriesIndex).toBe(1);
    });

    it('la règle enregistrée porte la fin (le détail l’affiche par recurrenceLabel)', async () => {
      const task = await create();
      expect(await series.updateRule(task.id, { ...MONTHLY_23, count: 6 })).toMatchObject({ ok: true, value: { count: 6, until: null } });
      expect(await ruleOf(task)).toMatchObject({ count: 6, until: null });
    });

    it('fin déjà dépassée : refusée avec un code clair, rien n’est écrit (critère 9)', async () => {
      const past = await create(defaultRecurrence('monthly', d('2026-09-01')), { date: d('2026-09-01') });
      expect(await series.updateRule(past.id, { ...defaultRecurrence('monthly', d('2026-09-01')), until: d('2026-09-10') })).toEqual({
        ok: false,
        error: 'end-in-past',
      });
      expect(await ruleOf(past)).toMatchObject({ until: null });
      expect(undo.getSnapshot().size).toBe(0);
    });

    it('fin avant la date de la tâche, nombre nul, fin double, jours vides : refusés', async () => {
      const later = await create(MONTHLY_23, { date: d('2026-10-10') });
      expect(await series.updateRule(later.id, { ...MONTHLY_23, until: d('2026-10-01') })).toEqual({ ok: false, error: 'end-before-start' });
      expect(await series.updateRule(later.id, { ...MONTHLY_23, count: 0 })).toEqual({ ok: false, error: 'invalid-rule' });
      expect(await series.updateRule(later.id, { ...MONTHLY_23, until: d('2027-01-01'), count: 3 })).toEqual({ ok: false, error: 'invalid-rule' });
      expect(await series.updateRule(later.id, { ...defaultRecurrence('weekly', d('2026-10-10')), weekdays: [] })).toEqual({ ok: false, error: 'invalid-rule' });
    });

    it('modifier la fréquence : la suivante suit la nouvelle règle ; chaque étape est annulable', async () => {
      const task = await create();
      await series.updateRule(task.id, EVERY_3_DAYS);
      expect((await completeAndNext(task)).date).toBe('2026-09-26');
      expect((await undo.undoLast()).status).toBe('undone'); // la complétion
      expect((await undo.undoLast()).status).toBe('undone'); // la règle
      expect(await ruleOf(task)).toMatchObject({ freq: 'monthly', interval: 1, monthDay: 23 });
    });

    it('tâche inconnue ou simple : erreurs', async () => {
      const simple = await createSimple();
      expect(await series.updateRule(simple.id, MONTHLY_23)).toEqual({ ok: false, error: 'not-recurrent' });
      expect(await series.updateRule(UNKNOWN, MONTHLY_23)).toEqual({ ok: false, error: 'not-found' });
    });
  });

  describe('arrêter la répétition (critère 6)', () => {
    it('la tâche devient simple et aucune suivante n’est créée', async () => {
      const task = await create();
      expect(await series.stop(task.id)).toMatchObject({ ok: true, value: { recurrenceId: null, seriesIndex: null, seriesTemplate: null } });
      await tasks.complete(task.id);
      db.clock.set(local(8, 24, 0, 5));
      await runRollover();
      const rows = await db.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM task');
      expect(rows[0]?.n).toBe(1);
      expect(entities.get(task.id)?.recurrenceId).toBeNull();
    });

    it('l’occurrence à venir déjà créée devient simple aussi ; la règle est supprimée', async () => {
      const first = await create();
      const second = await completeAndNext(first);
      await series.stop(first.id);
      expect(await get(second.id)).toMatchObject({ recurrenceId: null, seriesIndex: null });
      expect(await ruleOf(first)).toBeNull();
    });

    it('annulable : la règle et la tâche reviennent', async () => {
      const task = await create();
      await series.stop(task.id);
      expect(undo.getSnapshot().top).toMatchObject({ labelKey: 'undo.seriesStop' });
      expect((await undo.undoLast()).status).toBe('undone');
      expect(await get(task.id)).toMatchObject({ recurrenceId: task.recurrenceId, seriesIndex: 0 });
      expect(await ruleOf(task)).toMatchObject({ freq: 'monthly' });
      expect((await completeAndNext(task)).date).toBe('2026-10-23');
    });

    it('une occurrence détachée perd son écart ; une tâche simple est refusée', async () => {
      const task = await create();
      await series.updateOccurrence(task.id, { title: 'Exception' }, 'occurrence');
      await series.stop(task.id);
      expect(await get(task.id)).toMatchObject({ title: 'Exception', seriesTemplate: null, recurrenceId: null });
      expect(await series.stop(task.id)).toEqual({ ok: false, error: 'not-recurrent' });
      expect(await series.stop(UNKNOWN)).toEqual({ ok: false, error: 'not-found' });
    });

    it('arrêter après une complétion en avance : aucune suivante supplémentaire', async () => {
      const task = await create();
      const next = await completeAndNext(task);
      await series.stop(next.id);
      await tasks.complete(next.id);
      expect(await all(task)).toHaveLength(1);
    });
  });

  describe('reporter une occurrence (critère 4 : changement de date seul)', () => {
    const EVERY_2_DAYS: RecurrenceFields = { ...defaultRecurrence('daily', d('2026-09-23')), interval: 2 };

    it('« Cette occurrence » : la série garde son ancre (tous les 2 jours : 23, 25…)', async () => {
      const task = await create(EVERY_2_DAYS);
      const result = await series.postpone(task.id, 'tomorrow', 'occurrence');
      expect(result).toMatchObject({ ok: true, value: { date: '2026-09-24' } });
      expect((await completeAndNext(task)).date).toBe('2026-09-25');
    });

    it('« Toutes les suivantes » : la série repart de la nouvelle date (24, 26…)', async () => {
      const task = await create(EVERY_2_DAYS);
      await series.postpone(task.id, 'tomorrow', 'following');
      expect((await completeAndNext(task)).date).toBe('2026-09-26');
    });

    it('un report sans choix (appel direct, lot) ne décale pas la série ; son annulation rend tout', async () => {
      const task = await create(EVERY_2_DAYS);
      await tasks.postpone([task.id], { date: d('2026-09-30') });
      expect(await get(task.id)).toMatchObject({ date: '2026-09-30', seriesTemplate: { date: '2026-09-23' } });
      expect((await undo.undoLast()).status).toBe('undone');
      expect(await get(task.id)).toMatchObject({ date: '2026-09-23', seriesTemplate: null });
      await tasks.postpone([task.id], 'next-week');
      expect((await completeAndNext(task)).date).toBe('2026-09-25');
    });

    it('annulable ; terminée, simple, inconnue ou date invalide : refus', async () => {
      const task = await create(EVERY_2_DAYS);
      await series.postpone(task.id, { date: d('2026-09-28') }, 'following');
      expect((await undo.undoLast()).status).toBe('undone');
      expect(await get(task.id)).toMatchObject({ date: '2026-09-23', seriesTemplate: null });
      expect(await series.postpone(task.id, { date: '2026-02-31' as LocalDate }, 'occurrence')).toEqual({ ok: false, error: 'invalid-date' });
      const next = await completeAndNext(task);
      expect(await series.postpone(task.id, 'tomorrow', 'occurrence')).toEqual({ ok: false, error: 'already-done' });
      expect((await get(next.id)).date).toBe('2026-09-25');
      const simple = await createSimple();
      expect(await series.postpone(simple.id, 'tomorrow', 'occurrence')).toEqual({ ok: false, error: 'not-recurrent' });
      expect(await series.postpone(UNKNOWN, 'tomorrow', 'occurrence')).toEqual({ ok: false, error: 'not-found' });
    });
  });

  describe('supprimer une occurrence (critère 7, T-08 critère 8)', () => {
    it('« Cette occurrence » : la tâche part à la corbeille et la suivante est générée', async () => {
      const task = await create();
      expect((await series.remove(task.id, 'occurrence')).ok).toBe(true);
      const list = await all(task, true);
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({ id: task.id, deletedAt: expect.any(String) });
      expect(list[1]).toMatchObject({ date: '2026-10-23', seriesIndex: 1, deletedAt: null, title: 'Payer le loyer' });
      expect(entities.get(task.id)).toBeUndefined();
      expect(entities.get(must(list[1]).id)).toBeDefined();
      expect(await ruleOf(task)).not.toBeNull();
      expect(await trash()).toHaveLength(1);
    });

    it('« Cette occurrence » d’une occurrence détachée : la suivante reprend les valeurs de la série', async () => {
      const task = await create();
      await series.updateOccurrence(task.id, { title: 'Exception' }, 'occurrence');
      await series.remove(task.id, 'occurrence');
      expect((await all(task)).map((t) => t.title)).toEqual(['Payer le loyer']);
    });

    it('« Cette occurrence » ne duplique pas une suivante déjà créée', async () => {
      const first = await create();
      const second = await completeAndNext(first);
      await series.remove(first.id, 'occurrence');
      expect((await all(first)).map((t) => t.id)).toEqual([second.id]);
    });

    it('« Cette occurrence » de la dernière occurrence d’une série à fin : pas de suivante', async () => {
      const task = await create();
      await series.updateRule(task.id, { ...MONTHLY_23, count: 1 });
      await series.remove(task.id, 'occurrence');
      expect(await all(task)).toHaveLength(0);
    });

    it('« Toutes les suivantes » : la tâche part et la série s’arrête, occurrences à venir comprises', async () => {
      const first = await create();
      const second = await completeAndNext(first);
      await series.remove(second.id, 'following');
      expect(await ruleOf(first)).toBeNull();
      expect((await all(first)).map((t) => t.id)).toEqual([first.id]); // la première, terminée, reste
      expect((await get(first.id)).status).toBe('done');
      expect(entities.get(second.id)).toBeUndefined();
      expect(await trash()).toHaveLength(1);
    });

    it('annulable : « Cette occurrence » restaure la tâche, retire la suivante générée sans doublon en corbeille', async () => {
      const task = await create();
      await series.remove(task.id, 'occurrence');
      expect((await undo.undoLast()).status).toBe('undone');
      expect((await all(task)).map((t) => t.date)).toEqual(['2026-09-23']);
      expect(await trash()).toHaveLength(0);
      expect(entities.get(task.id)).toBeDefined();
      expect((await completeAndNext(task)).date).toBe('2026-10-23'); // terminer à nouveau recrée la suivante
    });

    it('annulable : « Toutes les suivantes » restaure la règle et les occurrences', async () => {
      const first = await create();
      const second = await completeAndNext(first);
      await undo.undoLast(); // rouvre la première et retire la seconde, pour isoler la suppression
      void second;
      await series.remove(first.id, 'following');
      expect((await undo.undoLast()).status).toBe('undone');
      expect(await ruleOf(first)).not.toBeNull();
      expect((await get(first.id)).deletedAt).toBeNull();
    });

    it('« Annuler » périmé si la suivante générée a été modifiée depuis', async () => {
      const task = await create();
      await series.remove(task.id, 'occurrence');
      const next = must((await all(task)).find((t) => t.seriesIndex === 1));
      await tasks.update(next.id, { note: 'modifiée' });
      expect((await undo.undoLast()).status).toBe('stale');
      expect((await get(next.id)).note).toBe('modifiée');
    });

    it('tâche simple ou inconnue : erreurs', async () => {
      const simple = await createSimple();
      expect(await series.remove(simple.id, 'occurrence')).toEqual({ ok: false, error: 'not-recurrent' });
      expect(await series.remove(UNKNOWN, 'following')).toEqual({ ok: false, error: 'not-found' });
    });
  });

  describe('interaction avec la complétion et le report de minuit', () => {
    it('occurrence détachée non faite : au changement de jour, la suivante a les valeurs de la série et l’occurrence est reportée', async () => {
      const task = await create();
      await series.updateOccurrence(task.id, { title: 'Exception', note: 'seule' }, 'occurrence');
      await db.data.repos.settings.set('tasks.carryOverUndone', true);
      db.clock.set(local(8, 24, 0, 5));
      await runRollover();
      const [first, next] = await all(task);
      expect(first).toMatchObject({ title: 'Exception', date: '2026-09-24', carriedOver: true, seriesTemplate: { date: '2026-09-23' } });
      expect(next).toMatchObject({ title: 'Payer le loyer', note: '', date: '2026-10-23', seriesIndex: 1 });
    });

    it('occurrence déplacée puis non faite : la suivante part de la date d’origine', async () => {
      const task = await create(EVERY_3_DAYS);
      await series.updateOccurrence(task.id, { date: d('2026-09-30') }, 'occurrence');
      await db.data.repos.settings.set('tasks.carryOverUndone', true);
      db.clock.set(local(9, 1, 0, 5));
      await runRollover();
      const list = await all(task);
      // 23 + 3 = 26, 29 (déjà passées), 2 oct. : la première à venir.
      expect(list.at(-1)).toMatchObject({ date: '2026-10-02', seriesIndex: 3 });
      expect(list[0]).toMatchObject({ date: '2026-10-01', carriedOver: true });
    });

    it('« toutes les suivantes » puis report de minuit : la suivante porte les nouvelles valeurs', async () => {
      const task = await create();
      await series.updateOccurrence(task.id, { title: 'Loyer 2027' }, 'following');
      db.clock.set(local(8, 24, 0, 5));
      await runRollover();
      expect((await all(task)).map((t) => t.title)).toEqual(['Loyer 2027', 'Loyer 2027']);
    });

    it('annuler la complétion d’une occurrence détachée rend la tâche et retire la suivante', async () => {
      const task = await create();
      await series.updateOccurrence(task.id, { title: 'Exception' }, 'occurrence');
      await tasks.complete(task.id);
      expect((await undo.undoLast()).status).toBe('undone');
      expect(await all(task)).toHaveLength(1);
      expect(await get(task.id)).toMatchObject({ status: 'todo', title: 'Exception', seriesTemplate: { title: 'Payer le loyer' } });
    });
  });

  describe('cas limites de fin (T-10 critères 5, 9)', () => {
    it('count atteint après modification : réduire à la position courante ne crée pas de suivante', async () => {
      const task = await create(EVERY_3_DAYS);
      const second = await completeAndNext(task);
      const third = await completeAndNext(second);
      await series.updateRule(third.id, { ...EVERY_3_DAYS, count: 3 });
      await tasks.complete(third.id);
      expect(await all(task)).toHaveLength(3);
    });

    it('until antérieur à l’occurrence courante : refusé, rien n’est écrit', async () => {
      const task = await create(EVERY_3_DAYS);
      const second = await completeAndNext(task);
      expect(await series.updateRule(second.id, { ...EVERY_3_DAYS, until: d('2026-09-24') })).toMatchObject({ ok: false });
      expect(await ruleOf(task)).toMatchObject({ until: null });
    });

    it('cette occurrence puis complétion : la suivante suit la règle d’origine, pas la modification', async () => {
      const task = await create(EVERY_3_DAYS, { time: asLocalTime('09:00') });
      await series.updateOccurrence(task.id, { date: d('2026-09-24'), time: asLocalTime('18:00'), title: 'Autre' }, 'occurrence');
      const next = await completeAndNext(task);
      expect(next).toMatchObject({ title: 'Payer le loyer', time: '09:00', date: '2026-09-26', seriesIndex: 1 });
    });

    it('arrêt puis annulation : la règle revient et la complétion recrée la suivante', async () => {
      const task = await create();
      await series.stop(task.id);
      expect((await undo.undoLast()).status).toBe('undone');
      expect(await ruleOf(task)).not.toBeNull();
      expect((await completeAndNext(task)).date).toBe('2026-10-23');
    });
  });
});

describe('series_template illisible en base (T-10, données futures)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE, local(8, 23, 8));
  });
  afterEach(() => db.close());

  it.each([['{oups'], ['{"title":"","note":"","icon":null,"time":null,"spaceId":"x","projectId":null,"date":null}'], ['42']])(
    'repli sûr : %s est lu comme « pas d’écart »',
    async (json) => {
      const deps: TaskUseCaseDeps = { clock: db.clock, ids: uuidGenerator, data: db.data, undo: createUndoStack(), taskEntities: createTaskEntities() };
      const created = await createTaskUseCases(deps).create({ title: 'Loyer', spaceId: SPACE_PRO_ID, date: d('2026-09-23'), recurrence: MONTHLY_23 });
      if (!created.ok) throw new Error('création');
      await db.driver.execute('UPDATE task SET series_template = ? WHERE id = ?', [json, created.value.id]);
      expect((await db.data.repos.tasks.getById(created.value.id))?.seriesTemplate).toBeNull();
    },
  );
});
